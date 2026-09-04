import Foundation
import Capacitor

@objc(DroggerLocationPlugin)
public class DroggerLocationPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "DroggerLocationPlugin"
    public let jsName = "DroggerLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPairedDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startNtrip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopNtrip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNtripStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchNtripSourceTable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSatellites", returnType: CAPPluginReturnPromise),
    ]

    /// 受信した NMEA を 1 行ずつ ログに 出すか (既定 false)。
    /// 種類と 本数は 5 秒ごとの 集計ログ ([NMEA] counts) で 分かるので、
    /// 生の行が 要るとき だけ true にする
    private static let logEveryNmeaLine = false

    private lazy var ble: DroggerBleManager = {
        let m = DroggerBleManager()
        m.onNmeaLine = { [weak self] line in
            // 受信機は 10Hz で 8 種類ほど 出すので、1 行ずつ 出すと 毎秒 40 行 に なる。
            // print は メインスレッドを 止めるため、BLE の 取りこぼしや 切断の 原因に
            // なりうる。生行が 要るときだけ ここを true にする
            if Self.logEveryNmeaLine {
                print("[NMEA] \(line)")
            }
            self?.handleNmeaLine(line)
        }
        m.onStatusChange = { [weak self] connected, name in
            self?.notifyListeners("statusChange", data: [
                "connected": connected,
                "deviceName": name as Any,
            ])
        }
        m.onError = { [weak self] code, message in
            self?.notifyListeners("error", data: ["code": code, "message": message])
        }
        return m
    }()

    @objc func start(_ call: CAPPluginCall) {
        let address = call.getString("deviceAddress")
        ble.start(deviceAddress: address)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        ble.stop()
        call.resolve()
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            "connected": ble.isConnected,
            "deviceName": ble.deviceName as Any,
        ])
    }

    @objc func listPairedDevices(_ call: CAPPluginCall) {
        // iOS では「ペアリング済み一覧」を取得する API が無い。
        // BLE はスキャンで都度発見するため、空配列を返して TS 側の
        // 自動フォールバック (名前無指定 start) に任せる。
        call.resolve(["devices": []])
    }
    // MARK: - NMEA パース

    /// Android 版 NmeaBuffer と同じ役割。GGA/RMC/GST の値をここに溜める。
    private struct NmeaBuffer {
        var lat: Double?
        var lon: Double?
        var altitude: Double?
        var geoidalSep: Double?
        var fixQuality: Int?
        var satellites: Int?
        var hdop: Double?
        var speedKnots: Double?
        var headingDeg: Double?
        var timeMillis: Double?
        /// GST 由来: RTK 受信機の std dev (m)。これがあれば HDOP × 3 より正確
        var stdLat: Double?
        var stdLon: Double?
        var stdAlt: Double?
        /// GGA field 13: 補正データを 受け取ってからの 経過時間 [s]。補正なしは 空欄
        var diffAge: Double?
        /// GGA field 14: 差分基準局 ID。NTRIP は 基準局の 番号、CLAS は 受信機内で
        /// 解くので 固定値になる
        var stationId: String?
    }

    private var nmea = NmeaBuffer()
    /// 直前に 採用した 精度の 出所 ("GST" / "FQ(4)" / "HDOP×3")。ログの 重複抑制用
    private var lastAccSource: String?
    /// 診断: 見た sentence の 種類と 出現回数 (5 秒ごとに ログへ 出して 空にする)
    private var seenTalkers = Set<String>()
    private var talkerCounts: [String: Int] = [:]
    private var lastTalkerSummaryMs: Double = 0

    private static let iso8601: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private func handleNmeaLine(_ rawLine: String) {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.hasPrefix("$") else { return }
        // チェックサム部を落として先頭の $ を除去 (Android 版と同じ簡易処理)
        let body = String(line.prefix(while: { $0 != "*" }).dropFirst())
        let parts = body.components(separatedBy: ",")
        guard let talker = parts.first else { return }

        // 診断 (Android 版と同じ): どの sentence が 来ているかを 5 秒ごとに 集計。
        // 精度が 典型値のままの ときに 「GST が そもそも 来ていない」ことを 確かめる
        if seenTalkers.insert(talker).inserted {
            print("[NMEA] new sentence: $\(talker)  first=\(line)")
        }
        talkerCounts[talker, default: 0] += 1
        let nowMs = Date().timeIntervalSince1970 * 1000
        if nowMs - lastTalkerSummaryMs > 5000 {
            lastTalkerSummaryMs = nowMs
            print("[NMEA] counts (last 5s+): \(talkerCounts)")
            talkerCounts.removeAll()
        }

        if talker.hasSuffix("GGA") {
            // NTRIP VRS 用に生 GGA を差し込む (キャスターに定期 upload)
            lastRawGga = line
            ntripClient?.updateGga(line)
            parseGga(parts)
            emitIfReady()
        } else if talker.hasSuffix("RMC") {
            parseRmc(parts)
            emitIfReady()
        } else if talker.hasSuffix("GST") {
            parseGst(parts)
        } else if talker.hasSuffix("GSV") {
            parseGsv(talker, parts)
        } else if talker.hasSuffix("GSA") {
            parseGsa(parts)
        }
        // HDT / PSAT (姿勢情報) は 未実装
    }

    /// $--GGA,hhmmss.ss,llll.lll,a,yyyyy.yyy,a,x,xx,x.x,x.x,M,x.x,M,x.x,xxxx*hh
    private func parseGga(_ parts: [String]) {
        guard parts.count >= 15 else { return }
        // NMEA サイクル開始 (通常 GGA が 1 発目) → 使用中フラグを リセット
        // (以降の このサイクルの GSA でセットされる)
        usedThisCycle.removeAll()
        for sat in satMap.values { sat.usedInFix = false }
        let time = parts[1]
        if let v = parseLatLon(parts[2], parts[3]) { nmea.lat = v }
        if let v = parseLatLon(parts[4], parts[5]) { nmea.lon = v }
        if let v = Int(parts[6]) { nmea.fixQuality = v }
        if let v = Int(parts[7]) { nmea.satellites = v }
        if let v = Double(parts[8]) { nmea.hdop = v }
        if let v = Double(parts[9]) { nmea.altitude = v }
        // GGA field 11: 受信機内蔵ジオイドと WGS84 楕円体の差 [m]
        if let v = Double(parts[11]) { nmea.geoidalSep = v }
        // GGA field 13 / 14: 補正の 経過時間 [s] と 差分基準局 ID。
        // CLAS か NTRIP かの 見分けに 使う (どちらも 品質は 4 / 5 で 同じ)。
        // 補正が 無い間は 空欄なので、その時は nil に 戻す
        nmea.diffAge = Double(parts[13])
        let sid = parts[14].trimmingCharacters(in: .whitespaces)
        nmea.stationId = sid.isEmpty ? nil : sid
        if !time.isEmpty { nmea.timeMillis = parseNmeaTime(time) }
    }

    /// $--GST,time,rms,semi_major,semi_minor,orientation,std_lat,std_lon,std_alt*cs
    /// 一部受信機は std_alt を省略 (8 フィールド) するので lat/lon が読めれば OK
    private func parseGst(_ parts: [String]) {
        guard parts.count >= 8 else { return }
        if let v = Double(parts[6]) { nmea.stdLat = v }
        if let v = Double(parts[7]) { nmea.stdLon = v }
        if parts.count >= 9 {
            let raw = String(parts[8].prefix(while: { $0 != "*" }))
            if let v = Double(raw) { nmea.stdAlt = v }
        }
    }

    /// $--RMC,hhmmss.ss,A,llll.lll,a,yyyyy.yyy,a,x.x,x.x,ddmmyy,x.x,a*hh
    private func parseRmc(_ parts: [String]) {
        guard parts.count >= 10 else { return }
        if let v = Double(parts[7]) { nmea.speedKnots = v }
        if let v = Double(parts[8]) { nmea.headingDeg = v }
    }

    /// "4354.2597156","N" → 43.904328...
    private func parseLatLon(_ value: String, _ hemi: String) -> Double? {
        guard !value.isEmpty, !hemi.isEmpty, let v = Double(value) else { return nil }
        let deg = floor(v / 100)
        let min = v - deg * 100
        var dec = deg + min / 60.0
        if hemi == "S" || hemi == "W" { dec = -dec }
        return dec
    }

    /// hhmmss.ss (UTC) → 今日の日付と組み合わせて epoch ms
    private func parseNmeaTime(_ hhmmss: String) -> Double {
        guard hhmmss.count >= 6,
              let hh = Int(hhmmss.prefix(2)),
              let mm = Int(hhmmss.dropFirst(2).prefix(2)),
              let ss = Int(hhmmss.dropFirst(4).prefix(2))
        else { return Date().timeIntervalSince1970 * 1000 }

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        var comp = cal.dateComponents([.year, .month, .day], from: Date())
        comp.hour = hh
        comp.minute = mm
        comp.second = ss
        comp.nanosecond = 0
        guard let d = cal.date(from: comp) else {
            return Date().timeIntervalSince1970 * 1000
        }
        return d.timeIntervalSince1970 * 1000
    }

    /// GGA/RMC を受けた時点で lat/lon が揃っていれば 1 サンプル emit
    private func emitIfReady() {
        guard let lat = nmea.lat, let lon = nmea.lon else { return }
        let t = nmea.timeMillis ?? (Date().timeIntervalSince1970 * 1000)
        let fq = nmea.fixQuality ?? 0

        // 水平精度の優先順位 (Android 版と厳密に同じ):
        //   1. GST があれば sqrt(σ_lat² + σ_lon²)
        //   2. Fix Quality ベースの典型値
        //   3. HDOP × 3.0m
        let fqTypicalAcc: Double?
        switch fq {
        case 4: fqTypicalAcc = 0.02
        case 5: fqTypicalAcc = 0.30
        case 2: fqTypicalAcc = 1.0
        case 1: fqTypicalAcc = 3.0
        default: fqTypicalAcc = nil
        }
        // 採用元が 変わった時だけ ログを出す (毎 emit だと 1〜5Hz で 流れて 読めない)。
        //   GST     … 受信機の std dev。実測値なので 精度表示が 刻々と 変わる
        //   FQ(n)   … 受信機が GST を 出していない。Fix 品質ごとの 固定値になる
        //   HDOP×3  … Fix 品質も 不明な 最終フォールバック
        let accSrc: String
        if nmea.stdLat != nil && nmea.stdLon != nil {
            accSrc = "GST"
        } else if fqTypicalAcc != nil {
            accSrc = "FQ(\(fq))"
        } else {
            accSrc = "HDOP×3"
        }
        if accSrc != lastAccSource {
            lastAccSource = accSrc
            print("[ACC] 精度の採用元: \(accSrc)")
        }

        let hAcc: Double
        if let sLat = nmea.stdLat, let sLon = nmea.stdLon {
            hAcc = (sLat * sLat + sLon * sLon).squareRoot()
        } else if let f = fqTypicalAcc {
            hAcc = f
        } else if let h = nmea.hdop {
            hAcc = h * 3.0
        } else {
            hAcc = -1.0
        }

        // 垂直精度: GST の std_alt → fq ベース → HDOP × 5.0m
        let fqTypicalVAcc: Double?
        switch fq {
        case 4: fqTypicalVAcc = 0.03
        case 5: fqTypicalVAcc = 0.50
        case 2: fqTypicalVAcc = 2.0
        case 1: fqTypicalVAcc = 5.0
        default: fqTypicalVAcc = nil
        }
        let vAcc: Double = nmea.stdAlt ?? fqTypicalVAcc ?? (nmea.hdop.map { $0 * 5.0 } ?? -1.0)

        var data: [String: Any] = [
            "lat": lat,
            "lon": lon,
            "accuracy_m": hAcc >= 0 ? hAcc : NSNull(),
            "altitude_accuracy_m": vAcc >= 0 ? vAcc : NSNull(),
            "speed_kmh": nmea.speedKnots.map { $0 * 1.852 } ?? NSNull(),  // knots → km/h
            "heading_deg": nmea.headingDeg ?? NSNull(),
            "altitude_m": nmea.altitude ?? NSNull(),
            // TS 側で 楕円体高 = altitude_m + geoidal_separation_m を計算し
            // JPGEO2024 を引いて正確な MSL 標高を求めるために必要
            "geoidal_separation_m": nmea.geoidalSep ?? NSNull(),
            "recorded_at": Self.iso8601.string(from: Date(timeIntervalSince1970: t / 1000)),
            "fixQuality": fq,
        ]
        data["hdop"] = nmea.hdop ?? NSNull()
        data["satellites"] = nmea.satellites ?? NSNull()
        // 補正の 出どころ判定用 (TS 側 correctionSource)
        data["diffAge"] = nmea.diffAge ?? NSNull()
        data["stationId"] = nmea.stationId ?? NSNull()
        // 精度が 実測 (GST) なのか 品質ごとの 典型値なのかを UI にも 渡す。
        // 出所が 分からないと 「いつも 同じ 2cm」を 実測だと 誤解する
        data["accuracySource"] = accSrc

        notifyListeners("location", data: data)
    }

    // MARK: - GSV / GSA パーサ (スカイマップ 用)
    //
    // 衛星ごとの (仰角 / 方位 / SNR / 使用中フラグ) を保持し、GSV グループ完了時に
    // 全 衛星のスナップショットを 'satellites' イベントで emit する。
    // Android 版 (android-ict/.../DroggerLocationPlugin.kt) の 移植。

    private final class SatInfo {
        let constellation: String
        let prn: Int
        var elevation: Int?
        var azimuth: Int?
        var snr: Int?
        var usedInFix = false
        /// 最後に GSV で 見えた時刻 [epoch ms]。古いエントリの 掃除に使う
        var lastSeenMs: Double = 0

        init(constellation: String, prn: Int) {
            self.constellation = constellation
            self.prn = prn
        }
    }

    /// "コンステレーション/PRN" → SatInfo
    private var satMap: [String: SatInfo] = [:]
    /// GSV は 複数行に分割される。talker 単位の 受信中メッセージ番号
    private var gsvGroups: [String: Set<Int>] = [:]
    /// GSA は 1 サイクルに 複数コンステレーション出力される。最新サイクル分の 使用中キー
    private var usedThisCycle: Set<String> = []

    /// GSV talker (GP/GL/GA/GB/GQ) → コンステレーション名
    private func talkerToConst(_ talker: String) -> String {
        if talker.hasPrefix("GP") { return "GPS" }
        if talker.hasPrefix("GL") { return "GLONASS" }
        if talker.hasPrefix("GA") { return "Galileo" }
        if talker.hasPrefix("GB") || talker.hasPrefix("BD") { return "BeiDou" }
        if talker.hasPrefix("GQ") { return "QZSS" }
        // GN は 通常は使わない (GSV は 普通 コンステレーション別)
        if talker.hasPrefix("GN") { return "Multi" }
        return "Other"
    }

    /// system_id (GSA の 拡張フィールド NMEA 4.10+) → コンステレーション名
    private func systemIdToConst(_ sid: String) -> String? {
        switch sid {
        case "1": return "GPS"
        case "2": return "GLONASS"
        case "3": return "Galileo"
        case "4": return "BeiDou"
        case "5": return "QZSS"
        default: return nil
        }
    }

    /// PRN 範囲から コンステレーション推定 (system_id 未対応 受信機向けフォールバック)
    private func prnRangeToConst(_ prn: Int) -> String {
        switch prn {
        case 1...32: return "GPS"
        case 33...64: return "SBAS"
        case 65...96: return "GLONASS"
        case 193...197: return "QZSS"
        case 201...235: return "BeiDou"
        case 301...336: return "Galileo"
        default: return "Other"
        }
    }

    /// $--GSV,total_msgs,msg_num,sats_in_view,{prn,elev,az,snr}*4 [,signal_id]
    /// (チェックサムは handleNmeaLine で 除去済み)
    private func parseGsv(_ talker: String, _ parts: [String]) {
        guard parts.count >= 4,
              let totalMsgs = Int(parts[1]),
              let msgNum = Int(parts[2]) else { return }
        let talkerConst = talkerToConst(talker)
        // $GNGSV (multi-constellation) の場合、衛星ごとに PRN 範囲から
        // コンステレーションを決定する。GSA が PRN 範囲で const 判定するのと
        // 揃える必要がある (使用中フラグの キーマッチのため)
        let isMultiTalker = talker.hasPrefix("GN")

        var received = gsvGroups[talker] ?? []
        if msgNum == 1 && !received.isEmpty {
            // 新サイクル開始:
            //   単一 talker (GPGSV 等) は そのコンステレーションの 前サイクル分を除去
            //   multi talker (GNGSV) は 対象が 特定できないので 上書きに任せる
            if !isMultiTalker {
                let prefix = "\(talkerConst)/"
                satMap = satMap.filter { !$0.key.hasPrefix(prefix) }
            }
            received.removeAll()
        }
        received.insert(msgNum)
        gsvGroups[talker] = received

        let nowMs = Date().timeIntervalSince1970 * 1000

        // 各 GSV 行に 最大 4 衛星
        var i = 4
        while i + 3 < parts.count {
            if let prn = Int(parts[i]) {
                let constellation = isMultiTalker ? prnRangeToConst(prn) : talkerConst
                let key = "\(constellation)/\(prn)"
                let sat = satMap[key] ?? SatInfo(constellation: constellation, prn: prn)
                sat.elevation = Int(parts[i + 1])
                sat.azimuth = Int(parts[i + 2])
                sat.snr = Int(parts[i + 3])
                sat.usedInFix = usedThisCycle.contains(key)
                sat.lastSeenMs = nowMs
                satMap[key] = sat
            }
            i += 4
        }

        // 全メッセージ受信完了 → snapshot を emit + グループ状態リセット
        if received.count >= totalMsgs {
            gsvGroups.removeValue(forKey: talker)
            // 3 秒以上 見なかった 衛星は 古いエントリなので 除去
            // (multi talker で リセットしない ぶん、ここで 蓄積を防ぐ)
            let cutoff = nowMs - 3000
            satMap = satMap.filter { $0.value.lastSeenMs == 0 || $0.value.lastSeenMs >= cutoff }
            emitSatellites()
        }
    }

    /// $--GSA,mode,fix_type,prn1..prn12,pdop,hdop,vdop[,system_id]
    /// インデックス: 0=talker, 1=mode, 2=fix_type, 3..14=PRN×12, 15=PDOP,
    ///              16=HDOP, 17=VDOP, [18=system_id]
    private func parseGsa(_ parts: [String]) {
        guard parts.count >= 15 else { return }
        let systemId = parts.count >= 19 ? parts[18] : ""
        let constHint = systemIdToConst(systemId)

        var changed = false
        for i in 3..<15 {
            guard let prn = Int(parts[i]) else { continue }
            let c = constHint ?? prnRangeToConst(prn)
            let key = "\(c)/\(prn)"
            usedThisCycle.insert(key)
            if let sat = satMap[key], !sat.usedInFix {
                sat.usedInFix = true
                changed = true
            }
        }
        // GSV グループ完了に頼らず、GSA で usedInFix が 変わったら 都度 emit。
        // これが無いと 「使用中 0/N」表示になる
        if changed { emitSatellites() }
    }

    /// usedInFix を 決定する。
    ///   GSA (usedThisCycle) が 来ていれば それを 信じる (正確)
    ///   来ていなければ SNR 上位 N 個 (N=GGA field 7 の 使用数) を 使用中と推定
    private func computeUsedInFix() {
        if !usedThisCycle.isEmpty {
            for sat in satMap.values {
                sat.usedInFix = usedThisCycle.contains("\(sat.constellation)/\(sat.prn)")
            }
            return
        }
        let n = nmea.satellites ?? 0
        if n <= 0 {
            for sat in satMap.values { sat.usedInFix = false }
            return
        }
        // SNR が nil の 衛星は 末尾 (-1 扱い)。SNR 降順で 並べる
        let sorted = satMap.values.sorted { ($0.snr ?? -1) > ($1.snr ?? -1) }
        for (idx, sat) in sorted.enumerated() {
            sat.usedInFix = idx < n && (sat.snr ?? -1) > 0
        }
    }

    /// TS 側 SatellitesSnapshot と 同じ形に 整形。
    /// Swift の Dictionary は 順序不定なので コンステレーション → PRN 順に 並べて
    /// 表示が ちらつかない ようにする (Android の LinkedHashMap 相当)
    private func satellitesPayload() -> [String: Any] {
        let sorted = satMap.values.sorted {
            $0.constellation == $1.constellation
                ? $0.prn < $1.prn
                : $0.constellation < $1.constellation
        }
        let arr: [[String: Any]] = sorted.map { sat in
            [
                "constellation": sat.constellation,
                "prn": sat.prn,
                "elevation": sat.elevation ?? NSNull(),
                "azimuth": sat.azimuth ?? NSNull(),
                "snr": sat.snr ?? NSNull(),
                "usedInFix": sat.usedInFix,
            ]
        }
        return [
            "satellites": arr,
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]
    }

    /// 衛星スナップショットを 送る 間隔 [ms]。
    /// GSV / GSA は 1 秒ごとに 来るが、スカイマップは そんなに 速く 動かなくてよい。
    /// 毎回 送ると ブリッジ越しの 更新と 再描画が 無駄に 回る。
    private static let satelliteEmitIntervalMs: Double = 5000
    private var lastSatEmitMs: Double = 0

    /// 衛星スナップショットを 送る。間隔を 空けて 間引く
    /// (getSatellites() で 引くときは いつでも 最新が 返る)
    private func emitSatellites() {
        let now = Date().timeIntervalSince1970 * 1000
        guard now - lastSatEmitMs >= Self.satelliteEmitIntervalMs else { return }
        lastSatEmitMs = now
        computeUsedInFix()
        notifyListeners("satellites", data: satellitesPayload())
    }

    @objc func getSatellites(_ call: CAPPluginCall) {
        call.resolve(satellitesPayload())
    }

    // MARK: - NTRIP

    private var ntripClient: NtripClient?
    private var ntripHost: String?
    private var ntripMountpoint: String?
    private var lastRawGga: String?

    @objc func startNtrip(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), !host.isEmpty,
              let port = call.getInt("port"),
              let mountpoint = call.getString("mountpoint"), !mountpoint.isEmpty else {
            call.reject("host / port / mountpoint は 必須です")
            return
        }
        let user = call.getString("user") ?? ""
        let pass = call.getString("pass") ?? ""
        let sendGga = call.getBool("sendGga") ?? true

        ntripClient?.stop()
        ntripClient = nil

        let client = NtripClient(
            host: host, port: port, mountpoint: mountpoint,
            user: user, pass: pass, sendGga: sendGga,
            onRtcm: { [weak self] data in
                // RTCM3 をそのまま Drogger へ書き込む (BLE MTU 分割は write() 側で処理)
                self?.ble.write(data)
            },
            onStatusChange: { [weak self] connected in
                self?.notifyNtripStatus(connected)
            },
            onError: { [weak self] code, message in
                self?.notifyListeners("error", data: ["code": code, "message": message])
            }
        )
        // BLE が既に接続済みなら直近の GGA を渡す
        if let g = lastRawGga { client.updateGga(g) }
        ntripClient = client
        ntripHost = host
        ntripMountpoint = mountpoint
        client.start()
        call.resolve()
    }

    @objc func stopNtrip(_ call: CAPPluginCall) {
        ntripClient?.stop()
        ntripClient = nil
        notifyNtripStatus(false)
        call.resolve()
    }

    @objc func getNtripStatus(_ call: CAPPluginCall) {
        call.resolve(ntripStatusDict(ntripClient?.isRunning ?? false))
    }

    @objc func fetchNtripSourceTable(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), !host.isEmpty,
              let port = call.getInt("port") else {
            call.reject("host / port は 必須です")
            return
        }
        NtripClient.fetchSourceTable(
            host: host, port: port,
            user: call.getString("user"), pass: call.getString("pass")
        ) { result in
            switch result {
            case .failure(let e):
                call.reject(e.localizedDescription)
            case .success(let raw):
                var mountpoints: [[String: Any]] = []
                for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
                    guard line.hasPrefix("STR;") else { continue }
                    let c = line.components(separatedBy: ";")
                    guard c.count >= 3 else { continue }
                    // STR;mountpoint;identifier;format;format-details;carrier;nav-system;
                    // network;country;lat;lng;nmea-required;solution;generator;compression;auth;fee;...
                    mountpoints.append([
                        "mountpoint": c.count > 1 ? c[1] : "",
                        "identifier": c.count > 2 ? c[2] : "",
                        "format": c.count > 3 ? c[3] : "",
                        "navSystem": c.count > 6 ? c[6] : "",
                        "country": c.count > 8 ? c[8] : "",
                        "nmeaRequired": (c.count > 11 ? c[11] : "0") == "1",
                        "auth": c.count > 15 ? c[15] : "N",
                        "fee": c.count > 16 ? c[16] : "N",
                    ])
                }
                call.resolve(["mountpoints": mountpoints, "raw": raw])
            }
        }
    }

    private func ntripStatusDict(_ connected: Bool) -> [String: Any] {
        return [
            "connected": connected,
            "host": ntripHost ?? NSNull(),
            "mountpoint": ntripMountpoint ?? NSNull(),
            "bytesReceived": ntripClient?.bytesReceived ?? 0,
            "lastRtcmAt": ntripClient?.lastRtcmAt ?? 0,
        ]
    }

    private func notifyNtripStatus(_ connected: Bool) {
        notifyListeners("ntripStatusChange", data: ntripStatusDict(connected))
    }
 
}
