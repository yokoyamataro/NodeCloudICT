import Foundation

/// NTRIP キャスターから 受信機へ 素通ししている RTCM3 を 横から 覗いて、
/// 基準局の 素性を 取り出す。
///
/// Android の RtcmParser.kt と 同じ 役割・同じ 手順で 書いてある
/// (片方だけ 直して ずれるのを 防ぐため、変えるときは 両方 揃えること)。
///
/// 読んでいるのは 4 種類。
///   1005 / 1006 … 基準局 ARP の ECEF 座標 + 局 ID (1006 は アンテナ高つき)
///   1007 / 1008 … アンテナ機種名
///   1033        … アンテナ機種名 + 受信機の 機種 / ファームウェア
/// それ以外は 種別と 到着間隔だけ 数える (この局が 何を 何秒ごとに 配信して
/// いるかが 分かる)。
///
/// RTCM3 フレーム:
///   0xD3 | 6bit 予約 + 10bit ペイロード長 | ペイロード | CRC-24Q 3 バイト
/// TCP は フレーム境界で 切れないので バッファに 溜めて 組み立てる。
final class RtcmParser {

    private static let preamble: UInt8 = 0xD3
    /// 壊れたデータで 無限に 膨らむのを 防ぐ (最大フレームは 1023+6 バイト)
    private static let maxBuffer = 8192
    /// WGS84
    private static let wgs84A = 6378137.0
    private static let wgs84F = 1.0 / 298.257223563

    /// 種別ごとの 到着状況。間隔は 「最初と 最後の 差 ÷ 回数」で 均す
    final class MessageStat {
        var count: Int = 0
        var firstAtMs: Double = 0
        var lastAtMs: Double = 0
        init(firstAtMs: Double) { self.firstAtMs = firstAtMs }
        /// 平均到着間隔 [s]。1 回しか 来ていなければ nil
        var intervalSec: Double? {
            guard count >= 2, lastAtMs > firstAtMs else { return nil }
            return (lastAtMs - firstAtMs) / 1000.0 / Double(count - 1)
        }
    }

    // MARK: - 取り出した 基準局の 素性 (どれも まだ 来ていなければ nil)

    private(set) var stationId: Int?
    /// ARP の 緯度 [deg]
    private(set) var lat: Double?
    /// ARP の 経度 [deg]
    private(set) var lon: Double?
    /// ARP の 楕円体高 [m]
    private(set) var altitude: Double?
    /// アンテナ高 [m]。1006 のみ (1005 には 入っていない)
    private(set) var antennaHeight: Double?
    private(set) var antennaDescriptor: String?
    private(set) var receiverType: String?
    private(set) var receiverFirmware: String?

    /// 種別 → 到着状況。挿入順を 保つため キー配列を 別に 持つ
    private var stats: [Int: MessageStat] = [:]
    private var statOrder: [Int] = []

    private var buf = [UInt8]()
    private let lock = NSLock()

    /// 種別 → 到着状況 の スナップショット
    func messageStats() -> [(Int, MessageStat)] {
        lock.lock(); defer { lock.unlock() }
        return statOrder.compactMap { t in stats[t].map { (t, $0) } }
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        buf.removeAll(keepingCapacity: true)
        stationId = nil
        lat = nil; lon = nil; altitude = nil
        antennaHeight = nil
        antennaDescriptor = nil
        receiverType = nil
        receiverFirmware = nil
        stats.removeAll()
        statOrder.removeAll()
    }

    /// 受信した RTCM の 生バイト列を 流し込む
    func feed(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        buf.append(contentsOf: data)
        // 入りきらない 分は 古い方を 捨てる (フレーム同期は 下の 走査で 取り直す)
        if buf.count > Self.maxBuffer {
            buf.removeFirst(buf.count - Self.maxBuffer)
        }
        extractFrames()
    }

    /// バッファの 先頭から フレームを 切り出せるだけ 切り出す
    private func extractFrames() {
        var pos = 0
        while true {
            // プリアンブルを 探す
            while pos < buf.count && buf[pos] != Self.preamble { pos += 1 }
            if buf.count - pos < 3 { break } // ヘッダが 揃っていない
            let payloadLen = (Int(buf[pos + 1] & 0x03) << 8) | Int(buf[pos + 2])
            let frameLen = 3 + payloadLen + 3
            if buf.count - pos < frameLen { break } // フレームが 揃っていない
            let crcCalc = crc24q(pos, 3 + payloadLen)
            let crcRecv =
                (Int(buf[pos + 3 + payloadLen]) << 16) |
                (Int(buf[pos + 4 + payloadLen]) << 8) |
                Int(buf[pos + 5 + payloadLen])
            if crcCalc != crcRecv {
                // 同期ずれ。1 バイト進めて 探し直す
                pos += 1
                continue
            }
            handlePayload(off: pos + 3, len: payloadLen)
            pos += frameLen
        }
        // 使い残しを 前に 詰める
        if pos > 0 { buf.removeFirst(min(pos, buf.count)) }
    }

    private func handlePayload(off: Int, len: Int) {
        guard len >= 2 else { return }
        let type = Int(getBits(off, 0, 12))
        let now = Date().timeIntervalSince1970 * 1000
        if let st = stats[type] {
            st.count += 1
            st.lastAtMs = now
        } else {
            let st = MessageStat(firstAtMs: now)
            st.count = 1
            st.lastAtMs = now
            stats[type] = st
            statOrder.append(type)
        }

        switch type {
        case 1005, 1006: parseStationArp(off: off, len: len, withHeight: type == 1006)
        case 1007, 1008: parseAntennaDescriptor(off: off, len: len)
        case 1033: parseReceiverDescriptor(off: off, len: len)
        default: break
        }
    }

    /// 1005 / 1006: 基準局 ARP の ECEF 座標。
    /// 12 種別 / 12 局ID / 6 ITRF年 / GPS,GLONASS,Galileo,基準局 各1 /
    /// 38 X / 1 発振器 / 1 予約 / 38 Y / 2 quarter cycle / 38 Z [/ 16 アンテナ高]
    private func parseStationArp(off: Int, len: Int, withHeight: Bool) {
        guard len >= 19 else { return }
        var p = 12
        stationId = Int(getBits(off, p, 12)); p += 12
        p += 6 + 1 + 1 + 1 + 1
        let x = Double(getBitsSigned(off, p, 38)) * 0.0001; p += 38
        p += 1 + 1
        let y = Double(getBitsSigned(off, p, 38)) * 0.0001; p += 38
        p += 2
        let z = Double(getBitsSigned(off, p, 38)) * 0.0001; p += 38
        if withHeight && len >= 21 {
            antennaHeight = Double(getBits(off, p, 16)) * 0.0001
        }
        let lla = ecefToLla(x, y, z)
        lat = lla.0; lon = lla.1; altitude = lla.2
    }

    /// 1007 / 1008: 12 種別 / 12 局ID / 8 文字数 / アンテナ機種名
    private func parseAntennaDescriptor(off: Int, len: Int) {
        guard len >= 5 else { return }
        var p = 12
        stationId = Int(getBits(off, p, 12)); p += 12
        let n = Int(getBits(off, p, 8)); p += 8
        guard let s = readAscii(off: off, bitPos: p, count: n, len: len) else { return }
        antennaDescriptor = s
    }

    /// 1033: 1007 の 中身に 続けて アンテナ製番 / 受信機機種 / ファーム / 製番。
    /// どれも 8bit の 文字数 + 本体 で、すべて バイト境界に 乗る。
    private func parseReceiverDescriptor(off: Int, len: Int) {
        guard len >= 5 else { return }
        var p = 12
        stationId = Int(getBits(off, p, 12)); p += 12
        let nAnt = Int(getBits(off, p, 8)); p += 8
        guard let ant = readAscii(off: off, bitPos: p, count: nAnt, len: len) else { return }
        antennaDescriptor = ant
        p += nAnt * 8
        p += 8 // アンテナ設置 ID
        let nSerial = Int(getBits(off, p, 8)); p += 8
        p += nSerial * 8 // アンテナ製造番号 (使わない)
        let nRecv = Int(getBits(off, p, 8)); p += 8
        guard let recv = readAscii(off: off, bitPos: p, count: nRecv, len: len) else { return }
        receiverType = recv
        p += nRecv * 8
        let nFw = Int(getBits(off, p, 8)); p += 8
        receiverFirmware = readAscii(off: off, bitPos: p, count: nFw, len: len)
    }

    /// bitPos は バイト境界に 乗っている 前提 (RTCM の 文字列は すべて そう)
    private func readAscii(off: Int, bitPos: Int, count: Int, len: Int) -> String? {
        if count <= 0 { return "" }
        let startByte = bitPos / 8
        guard startByte + count <= len else { return nil }
        var s = ""
        s.reserveCapacity(count)
        for i in 0..<count {
            let c = buf[off + startByte + i]
            // 印字可能な ASCII だけ 通す (壊れたフレームで 変な文字が 出ないように)
            if c >= 0x20 && c <= 0x7E { s.append(Character(UnicodeScalar(c))) }
        }
        return s
    }

    // MARK: - ビット取り出し / CRC / 座標変換

    /// off バイト目を 起点に、pos ビット目から len ビットを 符号なしで 読む
    private func getBits(_ off: Int, _ pos: Int, _ len: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in pos..<(pos + len) {
            let b = buf[off + (i >> 3)]
            v = (v << 1) | UInt64((b >> (7 - UInt8(i & 7))) & 1)
        }
        return v
    }

    /// 同上、2 の補数で 符号つき
    private func getBitsSigned(_ off: Int, _ pos: Int, _ len: Int) -> Int64 {
        let v = getBits(off, pos, len)
        let signBit: UInt64 = 1 << UInt64(len - 1)
        if v & signBit != 0 {
            return Int64(bitPattern: v) - Int64(1 << UInt64(len))
        }
        return Int64(bitPattern: v)
    }

    /// RTCM3 の CRC-24Q (多項式 0x1864CFB、初期値 0)
    private func crc24q(_ off: Int, _ len: Int) -> Int {
        var crc = 0
        for i in 0..<len {
            crc ^= Int(buf[off + i]) << 16
            for _ in 0..<8 {
                crc <<= 1
                if crc & 0x1000000 != 0 { crc ^= 0x1864CFB }
            }
        }
        return crc & 0xFFFFFF
    }

    /// ECEF [m] → 緯度 [deg] / 経度 [deg] / 楕円体高 [m] (WGS84)。
    /// Bowring の 閉形式。測地用途でも mm 級で 合う。
    private func ecefToLla(_ x: Double, _ y: Double, _ z: Double) -> (Double, Double, Double) {
        let a = Self.wgs84A
        let f = Self.wgs84F
        let b = a * (1 - f)
        let e2 = f * (2 - f)
        let ep2 = (a * a - b * b) / (b * b)
        let p = (x * x + y * y).squareRoot()
        if p == 0 {
            // 極点。経度は 定義できないので 0 に する
            return (z >= 0 ? 90.0 : -90.0, 0.0, abs(z) - b)
        }
        let th = atan2(a * z, b * p)
        let sinTh = sin(th)
        let cosTh = cos(th)
        let latRad = atan2(z + ep2 * b * sinTh * sinTh * sinTh, p - e2 * a * cosTh * cosTh * cosTh)
        let lonRad = atan2(y, x)
        let sinLat = sin(latRad)
        let n = a / (1 - e2 * sinLat * sinLat).squareRoot()
        let alt = p / cos(latRad) - n
        return (latRad * 180.0 / .pi, lonRad * 180.0 / .pi, alt)
    }
}
