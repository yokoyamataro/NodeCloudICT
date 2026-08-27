import Foundation
import CoreBluetooth

/// Drogger (RZS.D01) との BLE 接続を管理する。
/// Android 版が BT SPP を使うのに対し、iOS は Classic SPP が使えないため BLE (GATT) で接続する。
///
/// GATT 構成 (LightBlue で実測):
///   Service      0BABA001-0000-1000-8000-00805F9B34FB
///     Char 002   Notify のみ            → NMEA 受信
///     Char 003   Read/Write/WriteNoResp → RTCM 送信・設定
final class DroggerBleManager: NSObject {

    static let serviceUUID = CBUUID(string: "0BABA001-0000-1000-8000-00805F9B34FB")
    static let notifyCharUUID = CBUUID(string: "0BABA002-0000-1000-8000-00805F9B34FB")
    static let writeCharUUID = CBUUID(string: "0BABA003-0000-1000-8000-00805F9B34FB")

    /// Drogger 系デバイス名のパターン (TS 側 DROGGER_NAME_PATTERN と揃える)
    private static let namePattern = try! NSRegularExpression(
        pattern: "^(drogger|dg[-_]|rzs)", options: [.caseInsensitive])

    // MARK: - コールバック (プラグイン層が差し込む)

    /// NMEA を 1 行受信するたびに呼ばれる (CRLF は除去済み)
    var onNmeaLine: ((String) -> Void)?
    /// 接続状態が変化したとき
    var onStatusChange: ((Bool, String?) -> Void)?
    /// エラー発生時 (code, message)
    var onError: ((String, String) -> Void)?

    // MARK: - 内部状態

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var notifyChar: CBCharacteristic?
    private var writeChar: CBCharacteristic?

    /// 接続要求を受けたが Bluetooth がまだ poweredOn でない場合に true
    private var pendingStart = false
    /// start(deviceAddress:) で指定された UUID 文字列 (nil なら名前で自動選択)
    private var targetIdentifier: String?
    /// 明示的な stop() でない切断なら自動再接続する
    private var shouldReconnect = false
    /// Notify が 1 センテンス単位で届かない場合に備えた行バッファ
    private var lineBuffer = Data()
    /// BLE の書き込みキュー。canSendWriteWithoutResponse が false の間は溜める
    private var writeQueue: [Data] = []
    private var isDraining = false

    private(set) var isConnected = false
    private(set) var deviceName: String?

    override init() {
        super.init()
        // メインキューで動かす。Capacitor のイベント送出もメインスレッドが安全。
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: - 公開 API

    func start(deviceAddress: String?) {
        // 既に 目的の相手に 繋がっているなら 何もしない。
        // 計測ごとに watchSamples が start() を 呼ぶため、ここで 再スキャンすると
        // 接続中の peripheral を 掴み直して 接続が 一瞬切れる。
        if isConnected, let p = peripheral,
           deviceAddress == nil || deviceAddress == p.identifier.uuidString {
            shouldReconnect = true
            onStatusChange?(true, deviceName)
            return
        }
        targetIdentifier = deviceAddress
        shouldReconnect = true
        guard central.state == .poweredOn else {
            // まだ初期化中 or Bluetooth オフ。centralManagerDidUpdateState で再開する。
            pendingStart = true
            return
        }
        beginScan()
    }

    func stop() {
        shouldReconnect = false
        pendingStart = false
        central.stopScan()
        if let p = peripheral {
            central.cancelPeripheralConnection(p)
        }
        peripheral = nil
        notifyChar = nil
        writeChar = nil
        lineBuffer.removeAll()
        writeQueue.removeAll()
        if isConnected {
            isConnected = false
            deviceName = nil
            onStatusChange?(false, nil)
        }
    }

    /// RTCM3 などを受信機へ書き込む。BLE の MTU 制限に合わせて分割送信する。
    /// 送信バッファが空くまでは writeQueue に溜め、peripheralIsReady で続きを流す。
    func write(_ data: Data) {
        guard let p = peripheral, writeChar != nil else { return }
        let maxLen = p.maximumWriteValueLength(for: .withoutResponse)
        var offset = 0
        while offset < data.count {
            let end = min(offset + maxLen, data.count)
            writeQueue.append(data.subdata(in: offset..<end))
            offset = end
        }
        // 受信機が追いつかないときに RTCM が無限に溜まるのを防ぐ (古い分から捨てる)
        if writeQueue.count > 256 {
            writeQueue.removeFirst(writeQueue.count - 256)
        }
        drainWriteQueue()
    }

    // MARK: - 内部処理

    /// canSendWriteWithoutResponse が true の間だけキューを吐き出す
    private func drainWriteQueue() {
        guard !isDraining, let p = peripheral, let ch = writeChar else { return }
        isDraining = true
        defer { isDraining = false }
        while !writeQueue.isEmpty, p.canSendWriteWithoutResponse {
            p.writeValue(writeQueue.removeFirst(), for: ch, type: .withoutResponse)
        }
    }

    private func beginScan() {
        // Service UUID でフィルタすると広告に Service が載っていない機種を拾えないため、
        // 全スキャンして名前で判定する。
        central.scanForPeripherals(withServices: nil, options: nil)
    }

    private func matchesDroggerName(_ name: String?) -> Bool {
        guard let n = name else { return false }
        let range = NSRange(n.startIndex..<n.endIndex, in: n)
        return Self.namePattern.firstMatch(in: n, options: [], range: range) != nil
    }

    /// 受信バイト列を CRLF/LF で行に切り出す
    private func appendAndExtractLines(_ data: Data) {
        lineBuffer.append(data)
        while let idx = lineBuffer.firstIndex(of: 0x0A) { // LF
            var lineData = lineBuffer.subdata(in: lineBuffer.startIndex..<idx)
            if lineData.last == 0x0D { lineData.removeLast() } // CR
            lineBuffer.removeSubrange(lineBuffer.startIndex...idx)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                onNmeaLine?(line)
            }
        }
        // 異常データで無限に膨らむのを防ぐ
        if lineBuffer.count > 4096 { lineBuffer.removeAll() }
    }
}

// MARK: - CBCentralManagerDelegate

extension DroggerBleManager: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            if pendingStart {
                pendingStart = false
                beginScan()
            }
        case .poweredOff:
            onError?("bluetooth_off", "Bluetooth がオフになっています")
        case .unauthorized:
            onError?("permission_denied", "Bluetooth の使用が許可されていません")
        case .unsupported:
            onError?("unsupported", "この端末は BLE に対応していません")
        default:
            break
        }
    }

    func centralManager(_ c: CBCentralManager,
                        didDiscover p: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advName ?? p.name

        if let target = targetIdentifier {
            guard p.identifier.uuidString == target else { return }
        } else{
            guard matchesDroggerName(name) else { return }
        }

        c.stopScan()
        peripheral = p
        deviceName = name
        p.delegate = self
        c.connect(p, options: nil)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ c: CBCentralManager,
                        didFailToConnect p: CBPeripheral, error: Error?) {
        onError?("connect_failed", error?.localizedDescription ?? "接続に失敗しました")
    }

    func centralManager(_ c: CBCentralManager,
                        didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        print("[BLE] disconnected: \(error?.localizedDescription ?? "-")")
        if let ns = error as NSError? {
            print("[BLE] domain=\(ns.domain) code=\(ns.code)")
        }
        isConnected = false
        notifyChar = nil
        writeChar = nil
        lineBuffer.removeAll()
        // 切断中に溜まった RTCM は古すぎるので破棄する
        writeQueue.removeAll()

        if shouldReconnect {
            // deviceName は保持したまま再接続 (UI のちらつきを防ぐ)
            print("[BLE] reconnecting...")
            c.connect(p, options: nil)
        } else {
            peripheral = nil
            deviceName = nil
            onStatusChange?(false, nil)
        }
    }
}

// MARK: - CBPeripheralDelegate

extension DroggerBleManager: CBPeripheralDelegate {

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = p.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            onError?("service_not_found", "Drogger のサービスが見つかりません")
            return
        }
        p.discoverCharacteristics([Self.notifyCharUUID, Self.writeCharUUID], for: svc)
    }

    func peripheral(_ p: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            if ch.uuid == Self.notifyCharUUID {
                notifyChar = ch
                p.setNotifyValue(true, for: ch)
            } else if ch.uuid == Self.writeCharUUID {
                writeChar = ch
            }
        }
        guard notifyChar != nil else {
            onError?("characteristic_not_found", "NMEA 受信用の特性が見つかりません")
            return
        }
        isConnected = true
        onStatusChange?(true, deviceName)
    }

    func peripheral(_ p: CBPeripheral,
                    didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard ch.uuid == Self.notifyCharUUID, let data = ch.value else { return }
        appendAndExtractLines(data)
    }

    /// 送信バッファに空きができた。キューの続きを流す。
    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        drainWriteQueue()
    }
}

