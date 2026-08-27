//
//  NtripClient.swift
//  App
//
//  Created by TARO YOKOYAMA on 2026/08/22.
//


import Foundation
import Network

/// NTRIP 1.0/2.0 クライアント。RTCM3 補正をキャスターから TCP で受信して
/// onRtcm コールバックで通知する。Android 版 NtripClient の移植。
///
/// プロトコル:
/// - GET /MOUNTPOINT HTTP/1.0 + Basic 認証ヘッダ
/// - "ICY 200 OK" (旧式) or "HTTP/1.1 200 OK" (新式) 応答後は RTCM3 バイナリ
/// - SourceTable 取得は 空 mountpoint で GET / HTTP/1.0
/// - VRS は定期的に最新 GGA をキャスターへ upload 必須
final class NtripClient {

    private static let ggaIntervalSec: TimeInterval = 10
    private static let connectTimeoutSec: TimeInterval = 10
    /// 通常 RTCM は 1 秒毎に来るが、瞬断や一時的遅延に耐性を持たせる
    private static let readTimeoutSec: TimeInterval = 90
    private static let userAgent = "NTRIP NodeCloudICT/1.0"

    private let host: String
    private let port: Int
    private let mountpoint: String
    private let user: String
    private let pass: String
    private let sendGga: Bool

    private let onRtcm: (Data) -> Void
    private let onStatusChange: (Bool) -> Void
    private let onError: (String, String) -> Void

    private let queue = DispatchQueue(label: "jp.nodecloud.ict.ntrip")
    private var connection: NWConnection?
    private var ggaTimer: DispatchSourceTimer?

    private var running = false
    private var headerDone = false
    private var headerBuffer = Data()
    private var latestGga: String?
    private var reconnectAttempts = 0
    private var lastRtcmEmitAt: TimeInterval = 0

    private(set) var bytesReceived: Int64 = 0
    private(set) var lastRtcmAt: Double = 0

    init(host: String, port: Int, mountpoint: String, user: String, pass: String,
         sendGga: Bool,
         onRtcm: @escaping (Data) -> Void,
         onStatusChange: @escaping (Bool) -> Void,
         onError: @escaping (String, String) -> Void) {
        self.host = host
        self.port = port
        self.mountpoint = mountpoint
        self.user = user
        self.pass = pass
        self.sendGga = sendGga
        self.onRtcm = onRtcm
        self.onStatusChange = onStatusChange
        self.onError = onError
    }

    var isRunning: Bool { queue.sync { running } }

    /// 呼出側 (DroggerLocationPlugin) が GGA を受信したら最新版を差し込む
    func updateGga(_ ggaLine: String) {
        queue.async { self.latestGga = ggaLine }
    }

    func start() {
        queue.async {
            guard !self.running else { return }
            self.running = true
            self.reconnectAttempts = 0
            self.connectAndStream()
        }
    }

    func stop() {
        queue.async {
            guard self.running else { return }
            self.running = false
            self.cleanup()
            self.onStatusChange(false)
        }
    }

    // MARK: - 接続

    private func connectAndStream() {
        headerDone = false
        headerBuffer.removeAll()

        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            fail("ntrip_io", "port が不正です: \(port)", fatal: true)
            return
        }
        let params = NWParameters.tcp
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
        connection = conn

        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.sendRequest()
                self.receiveLoop()
            case .failed(let err):
                self.fail("ntrip_io", self.hintFor(err), fatal: false)
            case .cancelled:
                break
            default:
                break
            }
        }
        conn.start(queue: queue)

        // 接続タイムアウト
        queue.asyncAfter(deadline: .now() + Self.connectTimeoutSec) { [weak self] in
            guard let self, self.running else { return }
            if self.connection === conn, conn.state != .ready {
                self.fail("ntrip_io", "タイムアウト - キャスターの応答なし", fatal: false)
            }
        }
    }

    private func sendRequest() {
        let mp = mountpoint.hasPrefix("/") ? mountpoint : "/\(mountpoint)"
        let cred = Data("\(user):\(pass)".utf8).base64EncodedString()
        var req = ""
        req += "GET \(mp) HTTP/1.0\r\n"
        req += "User-Agent: \(Self.userAgent)\r\n"
        req += "Accept: */*\r\n"
        req += "Connection: close\r\n"
        req += "Authorization: Basic \(cred)\r\n"
        req += "Ntrip-Version: Ntrip/2.0\r\n"
        req += "\r\n"
        connection?.send(content: Data(req.utf8), completion: .contentProcessed { _ in })
    }

    private func receiveLoop() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self, self.running else { return }

            if let error {
                self.fail("ntrip_io", self.hintFor(error), fatal: false)
                return
            }
            if let data, !data.isEmpty {
                if self.headerDone {
                    self.handleRtcm(data)
                } else {
                    self.handleHeader(data)
                }
            }
            if isComplete {
                // キャスターが接続を閉じた → 再接続へ
                self.fail("ntrip_io", "接続が閉じられました", fatal: false)
                return
            }
            self.receiveLoop()
        }
    }

    /// ヘッダ部を \r\n\r\n (または ICY 応答) まで読み、残りを RTCM として扱う
    private func handleHeader(_ data: Data) {
        headerBuffer.append(data)

        // 最初の 1 行で応答種別を判定
        guard let firstLineEnd = headerBuffer.firstRange(of: Data("\r\n".utf8)) else {
            if headerBuffer.count > 8192 {
                fail("ntrip_io", "NTRIP 応答が不正です", fatal: true)
            }
            return
        }
        let firstLine = String(decoding: headerBuffer[..<firstLineEnd.lowerBound], as: UTF8.self)

        if firstLine.hasPrefix("ICY 200 OK") {
            // NTRIP 1.0: 追加ヘッダなし。ただし実装によっては空行が続く
            let rest = headerBuffer[firstLineEnd.upperBound...]
            finishHeader(rest: Data(rest))
            return
        }
        if firstLine.hasPrefix("HTTP/1."), firstLine.contains(" 200 ") {
            // NTRIP 2.0: 空行までヘッダを読み捨て
            guard let sep = headerBuffer.firstRange(of: Data("\r\n\r\n".utf8)) else {
                if headerBuffer.count > 65536 {
                    fail("ntrip_io", "NTRIP ヘッダが長すぎます", fatal: true)
                }
                return
            }
            let rest = headerBuffer[sep.upperBound...]
            finishHeader(rest: Data(rest))
            return
        }
        if firstLine.contains(" 401") {
            fail("ntrip_io", "NTRIP 認証失敗 (user/pass を確認)", fatal: true); return
        }
        if firstLine.contains(" 404") {
            fail("ntrip_io", "NTRIP mountpoint が見つかりません", fatal: true); return
        }
        if firstLine.hasPrefix("SOURCETABLE") {
            fail("ntrip_io", "mountpoint 未指定 (SourceTable 応答)", fatal: true); return
        }
        fail("ntrip_io", "NTRIP 応答 不明: \(firstLine)", fatal: true)
    }

    private func finishHeader(rest: Data) {
        headerDone = true
        headerBuffer.removeAll()
        reconnectAttempts = 0
        onStatusChange(true)
        startGgaTimer()
        if !rest.isEmpty { handleRtcm(rest) }
    }

    private func handleRtcm(_ data: Data) {
        bytesReceived += Int64(data.count)
        lastRtcmAt = Date().timeIntervalSince1970 * 1000
        onRtcm(data)

        // バッジの KB カウンタ更新用に 2 秒に 1 回 status を emit
        let now = Date().timeIntervalSince1970
        if now - lastRtcmEmitAt > 2 {
            lastRtcmEmitAt = now
            onStatusChange(true)
        }
    }

    // MARK: - GGA upload (VRS)

    private func startGgaTimer() {
        guard sendGga else { return }
        ggaTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        // 最初の GGA は接続直後に一度だけ 2 秒待って送る (VRS の初回位置指示)
        t.schedule(deadline: .now() + 2, repeating: Self.ggaIntervalSec)
        t.setEventHandler { [weak self] in
            guard let self, self.running, let g = self.latestGga else { return }
            let line = g.hasSuffix("\r\n") ? g : g + "\r\n"
            self.connection?.send(content: Data(line.utf8), completion: .contentProcessed { _ in })
        }
        t.resume()
        ggaTimer = t
    }

    // MARK: - エラーと再接続

    private func hintFor(_ error: Error) -> String {
        let ns = error as NSError
        if let nw = error as? NWError {
            switch nw {
            case .posix(let code):
                switch code {
                case .ECONNREFUSED: return "接続拒否 - port が違うかキャスター停止中"
                case .ETIMEDOUT: return "タイムアウト - キャスターの応答なし"
                case .ENOTCONN, .ECONNRESET: return "接続が切断されました"
                default: break
                }
            case .dns:
                return "DNS 解決失敗 - hostname のスペル又は接続を確認"
            default: break
            }
        }
        return ns.localizedDescription
    }

    /// fatal=true は認証失敗など再接続しても治らないもの
    private func fail(_ code: String, _ message: String, fatal: Bool) {
        guard running else { return }
        if reconnectAttempts == 0 {
            onError(code, message)   // 初回のみユーザーに通知
        }
        cleanup()
        onStatusChange(false)

        if fatal {
            running = false
            return
        }
        reconnectAttempts += 1
        let delay: TimeInterval
        switch reconnectAttempts {
        case ...1: delay = 3
        case ...3: delay = 5
        case ...6: delay = 10
        default: delay = 15
        }
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.running else { return }
            self.connectAndStream()
        }
    }

    private func cleanup() {
        ggaTimer?.cancel()
        ggaTimer = nil
        connection?.cancel()
        connection = nil
        headerDone = false
        headerBuffer.removeAll()
    }

    // MARK: - SourceTable

    /// SourceTable を取得。生テキスト (STR;/CAS;/NET; 行) を返し、パースは呼出側。
    static func fetchSourceTable(host: String, port: Int, user: String?, pass: String?,
                                 timeout: TimeInterval = 10,
                                 completion: @escaping (Result<String, Error>) -> Void) {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            completion(.failure(NSError(domain: "ntrip", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "port が不正です"])))
            return
        }
        let q = DispatchQueue(label: "jp.nodecloud.ict.ntrip.sourcetable")
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
        var buffer = Data()
        var finished = false

        func finish(_ r: Result<String, Error>) {
            guard !finished else { return }
            finished = true
            conn.cancel()
            completion(r)
        }

        q.asyncAfter(deadline: .now() + timeout) {
            finish(.failure(NSError(domain: "ntrip", code: -2,
                userInfo: [NSLocalizedDescriptionKey: "SourceTable 取得タイムアウト"])))
        }

        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                if let error { finish(.failure(error)); return }
                if let data { buffer.append(data) }
                let text = String(decoding: buffer, as: UTF8.self)
                if isComplete || text.contains("ENDSOURCETABLE") {
                    // ヘッダを空行まで捨てて本文だけ返す
                    var body = text
                    if let r = text.range(of: "\r\n\r\n") {
                        let first = String(text[..<(text.range(of: "\r\n")?.lowerBound ?? text.startIndex)])
                        if !(first.hasPrefix("SOURCETABLE 200 OK")
                             || (first.hasPrefix("HTTP/1.") && first.contains(" 200 "))) {
                            finish(.failure(NSError(domain: "ntrip", code: -3,
                                userInfo: [NSLocalizedDescriptionKey: "SourceTable 取得失敗: \(first)"])))
                            return
                        }
                        body = String(text[r.upperBound...])
                    }
                    if let e = body.range(of: "ENDSOURCETABLE") {
                        body = String(body[..<e.lowerBound])
                    }
                    finish(.success(body))
                    return
                }
                receive()
            }
        }

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                var req = "GET / HTTP/1.0\r\n"
                req += "User-Agent: \(NtripClient.userAgent)\r\n"
                if let u = user, !u.isEmpty {
                    let cred = Data("\(u):\(pass ?? "")".utf8).base64EncodedString()
                    req += "Authorization: Basic \(cred)\r\n"
                }
                req += "Accept: */*\r\n"
                req += "Connection: close\r\n\r\n"
                conn.send(content: Data(req.utf8), completion: .contentProcessed { _ in })
                receive()
            case .failed(let err):
                finish(.failure(err))
            default:
                break
            }
        }
        conn.start(queue: q)
    }
}