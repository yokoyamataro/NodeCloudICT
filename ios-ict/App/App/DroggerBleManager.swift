import Foundation
import CoreBluetooth

/// Drogger (RZS.D01 / RWS.DC03 など) との BLE 接続を管理する。
/// Android 版が BT SPP を使うのに対し、iOS は Classic SPP が使えないため BLE (GATT) で接続する。
///
/// GATT 構成 (RZS.D01 を LightBlue で実測):
///   Service      0BABA001-0000-1000-8000-00805F9B34FB
///     Char 002   Notify のみ            → NMEA 受信
///     Char 003   Read/Write/WriteNoResp → RTCM 送信・設定
///
/// 機種によって GATT が 違う (RWS.DC03 など) ので、上の Service が 無ければ
/// 標準の Service を 除いた 中から「Notify できる 特性」と「書ける 特性」の
/// 組を 探して 同じように 使う。中身は どの機種も NMEA / RTCM の 素通しなので、
/// 通り道さえ 見つかれば 上の層は そのまま 動く。
final class DroggerBleManager: NSObject {

    static let serviceUUID = CBUUID(string: "0BABA001-0000-1000-8000-00805F9B34FB")
    static let notifyCharUUID = CBUUID(string: "0BABA002-0000-1000-8000-00805F9B34FB")
    static let writeCharUUID = CBUUID(string: "0BABA003-0000-1000-8000-00805F9B34FB")

    /// 通り道を 探すときに 飛ばす 標準 Service (汎用属性 / 端末情報 / 電池 など)
    private static let standardServiceUUIDs: Set<CBUUID> = [
        CBUUID(string: "1800"), // Generic Access
        CBUUID(string: "1801"), // Generic Attribute
        CBUUID(string: "180A"), // Device Information
        CBUUID(string: "180F"), // Battery
        CBUUID(string: "1805"), // Current Time
        CBUUID(string: "FE59"), // DFU (Nordic)
    ]

    /// Drogger 系デバイス名のパターン (TS 側 DROGGER_NAME_PATTERN と揃える)
    /// Drogger-XXX / DG-PRO1 / RZS.D01 / RWS.DC03 のような 名乗り方を 拾う
    private static let namePattern = try! NSRegularExpression(
        pattern: "^(drogger|dg[-_]|rzs|rws)", options: [.caseInsensitive])

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
    /// スキャン中に 見かけた名前 (同じ名前を 何度も ログに 出さないため)
    private var seenNames = Set<String>()
    /// 書き込みの 種類。応答なしで 書けない機種は 応答ありで 1 本ずつ 送る
    private var writeType: CBCharacteristicWriteType = .withoutResponse
    /// 応答ありのとき、返事待ちか
    private var awaitingWriteResponse = false
    /// 特性を 探している 途中の Service 数。0 になったら 通り道を 決める
    private var pendingServiceCount = 0

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
        awaitingWriteResponse = false
        pendingServiceCount = 0
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
        let maxLen = p.maximumWriteValueLength(for: writeType)
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

    /// canSendWriteWithoutResponse が true の間だけキューを吐き出す。
    /// 応答ありでしか 書けない機種は、返事を もらってから 次を 送る。
    private func drainWriteQueue() {
        guard !isDraining, let p = peripheral, let ch = writeChar else { return }
        isDraining = true
        defer { isDraining = false }
        if writeType == .withResponse {
            guard !awaitingWriteResponse, !writeQueue.isEmpty else { return }
            awaitingWriteResponse = true
            p.writeValue(writeQueue.removeFirst(), for: ch, type: .withResponse)
            return
        }
        while !writeQueue.isEmpty, p.canSendWriteWithoutResponse {
            p.writeValue(writeQueue.removeFirst(), for: ch, type: .withoutResponse)
        }
    }

    private func beginScan() {
        // Service UUID でフィルタすると広告に Service が載っていない機種を拾えないため、
        // 全スキャンして名前で判定する。
        seenNames.removeAll()
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
        } else {
            // 名前が Drogger 系か、広告に Drogger の Service が 載っていれば 採用する。
            // 機種が増えても 名前を 足さずに 拾えるよう、両方を 見る
            let advertisesService =
                (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?
                    .contains(Self.serviceUUID) ?? false
            // 繋がらないときに どんな名前で 広告しているか 分からないと 追えないので、
            // 見かけた名前を 1 回だけ 出す
            if let n = name, seenNames.insert(n).inserted {
                print("[BLE] found: \(n)")
            }
            guard matchesDroggerName(name) || advertisesService else { return }
        }

        c.stopScan()
        peripheral = p
        deviceName = name
        p.delegate = self
        c.connect(p, options: nil)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        // 機種によって GATT が 違うことがあるので、全部 拾ってから 選ぶ
        // (見つからなかったときに 何が あったのかを 出せるようにする)
        p.discoverServices(nil)
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
        awaitingWriteResponse = false
        pendingServiceCount = 0

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
        let services = p.services ?? []
        print("[BLE] services: \(services.map { $0.uuid.uuidString }.joined(separator: ", "))")
        // 既知の Drogger の Service が あれば それだけ。無い機種 (RWS.DC03 など) は
        // 標準の Service を 除いた 全部から NMEA の 通り道を 探す
        let targets: [CBService]
        if let known = services.first(where: { $0.uuid == Self.serviceUUID }) {
            targets = [known]
        } else {
            targets = services.filter { !Self.standardServiceUUIDs.contains($0.uuid) }
        }
        guard !targets.isEmpty else {
            onError?("service_not_found", "NMEA を 流している サービスが 見つかりません")
            return
        }
        notifyChar = nil
        writeChar = nil
        pendingServiceCount = targets.count
        for s in targets { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            if ch.uuid == Self.notifyCharUUID {
                notifyChar = ch
            } else if ch.uuid == Self.writeCharUUID {
                writeChar = ch
                writeType = ch.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
            } else if service.uuid != Self.serviceUUID {
                // 未知の機種: Notify できる 特性を 受信、書ける 特性を 送信に 使う。
                // 先に 見つかった方を 採る (どちらも 1 本しか 無いのが 普通)
                if notifyChar == nil,
                   ch.properties.contains(.notify) || ch.properties.contains(.indicate) {
                    notifyChar = ch
                }
                if writeChar == nil,
                   ch.properties.contains(.writeWithoutResponse) || ch.properties.contains(.write) {
                    writeChar = ch
                    writeType =
                        ch.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
                }
            }
        }
        // 全部の Service を 見終わってから 判断する (通り道が 後ろの Service に あることもある)
        pendingServiceCount -= 1
        guard pendingServiceCount <= 0 else { return }
        guard let notify = notifyChar else {
            onError?("characteristic_not_found", "NMEA 受信用の特性が見つかりません")
            return
        }
        print("[BLE] notify=\(notify.uuid.uuidString) write=\(writeChar?.uuid.uuidString ?? "-")")
        p.setNotifyValue(true, for: notify)
        isConnected = true
        onStatusChange?(true, deviceName)
    }

    func peripheral(_ p: CBPeripheral,
                    didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard ch.uuid == notifyChar?.uuid, let data = ch.value else { return }
        appendAndExtractLines(data)
    }

    /// 送信バッファに空きができた。キューの続きを流す。
    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        drainWriteQueue()
    }

    /// 応答ありの 書き込みが 1 本 終わった。続きを 流す
    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        awaitingWriteResponse = false
        drainWriteQueue()
    }
}


