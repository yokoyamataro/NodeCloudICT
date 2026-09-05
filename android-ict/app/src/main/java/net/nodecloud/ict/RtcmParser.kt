package net.nodecloud.ict

import android.util.Log
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * NTRIP キャスターから 受信機へ 素通ししている RTCM3 を 横から 覗いて、
 * 基準局の 素性を 取り出す。
 *
 * iOS の RtcmParser.swift と 同じ 役割・同じ 手順で 書いてある
 * (片方だけ 直して ずれるのを 防ぐため、変えるときは 両方 揃えること)。
 *
 * 読んでいるのは 4 種類。
 *   1005 / 1006 … 基準局 ARP の ECEF 座標 + 局 ID (1006 は アンテナ高つき)
 *   1007 / 1008 … アンテナ機種名
 *   1033        … アンテナ機種名 + 受信機の 機種 / ファームウェア
 * それ以外は 種別と 到着間隔だけ 数える (この局が 何を 何秒ごとに 配信して
 * いるかが 分かる)。
 *
 * RTCM3 フレーム:
 *   0xD3 | 6bit 予約 + 10bit ペイロード長 | ペイロード | CRC-24Q 3 バイト
 * TCP は フレーム境界で 切れないので バッファに 溜めて 組み立てる。
 */
class RtcmParser {

    companion object {
        private const val TAG = "RtcmParser"
        private const val PREAMBLE = 0xD3
        /** 壊れたデータで 無限に 膨らむのを 防ぐ (最大フレームは 1023+6 バイト) */
        private const val MAX_BUFFER = 8192
        /** WGS84 */
        private const val WGS84_A = 6378137.0
        private const val WGS84_F = 1.0 / 298.257223563
    }

    /** 種別ごとの 到着状況。間隔は 「最初と 最後の 差 ÷ 回数」で 均す */
    class MessageStat(
        var count: Long = 0,
        var firstAtMs: Long = 0,
        var lastAtMs: Long = 0,
    ) {
        /** 平均到着間隔 [s]。1 回しか 来ていなければ null */
        val intervalSec: Double?
            get() = if (count >= 2 && lastAtMs > firstAtMs) {
                (lastAtMs - firstAtMs) / 1000.0 / (count - 1)
            } else null
    }

    // ---- 取り出した 基準局の 素性 (どれも まだ 来ていなければ null) ----

    @Volatile var stationId: Int? = null
        private set
    /** ARP の 緯度 [deg] */
    @Volatile var lat: Double? = null
        private set
    /** ARP の 経度 [deg] */
    @Volatile var lon: Double? = null
        private set
    /** ARP の 楕円体高 [m] */
    @Volatile var altitude: Double? = null
        private set
    /** アンテナ高 [m]。1006 のみ (1005 には 入っていない) */
    @Volatile var antennaHeight: Double? = null
        private set
    @Volatile var antennaDescriptor: String? = null
        private set
    @Volatile var receiverType: String? = null
        private set
    @Volatile var receiverFirmware: String? = null
        private set

    private val stats = LinkedHashMap<Int, MessageStat>()

    /** 種別 → 到着状況 の スナップショット (呼び出し側で 使い切る) */
    @Synchronized
    fun messageStats(): List<Pair<Int, MessageStat>> = stats.entries.map { it.key to it.value }

    @Synchronized
    fun reset() {
        bufLen = 0
        stationId = null
        lat = null; lon = null; altitude = null
        antennaHeight = null
        antennaDescriptor = null
        receiverType = null
        receiverFirmware = null
        stats.clear()
    }

    private var buf = ByteArray(MAX_BUFFER)
    private var bufLen = 0

    /**
     * 受信した RTCM の 生バイト列を 流し込む。
     * NTRIP の 読み取りスレッドから 呼ばれる。
     */
    @Synchronized
    fun feed(data: ByteArray, len: Int) {
        if (len <= 0) return
        // 入りきらない 分は 古い方を 捨てる (フレーム同期は 下の 走査で 取り直す)
        if (bufLen + len > buf.size) {
            val keep = (buf.size - len).coerceAtLeast(0)
            if (keep > 0 && bufLen > keep) {
                System.arraycopy(buf, bufLen - keep, buf, 0, keep)
                bufLen = keep
            } else if (keep == 0) {
                bufLen = 0
            }
        }
        val copyLen = minOf(len, buf.size - bufLen)
        System.arraycopy(data, 0, buf, bufLen, copyLen)
        bufLen += copyLen
        extractFrames()
    }

    /** バッファの 先頭から フレームを 切り出せるだけ 切り出す */
    private fun extractFrames() {
        var pos = 0
        while (true) {
            // プリアンブルを 探す
            while (pos < bufLen && (buf[pos].toInt() and 0xFF) != PREAMBLE) pos++
            if (bufLen - pos < 3) break // ヘッダが 揃っていない
            val payloadLen = ((buf[pos + 1].toInt() and 0x03) shl 8) or (buf[pos + 2].toInt() and 0xFF)
            val frameLen = 3 + payloadLen + 3
            if (bufLen - pos < frameLen) break // フレームが 揃っていない
            val crcCalc = crc24q(buf, pos, 3 + payloadLen)
            val crcRecv =
                ((buf[pos + 3 + payloadLen].toInt() and 0xFF) shl 16) or
                    ((buf[pos + 4 + payloadLen].toInt() and 0xFF) shl 8) or
                    (buf[pos + 5 + payloadLen].toInt() and 0xFF)
            if (crcCalc != crcRecv) {
                // 同期ずれ。1 バイト進めて 探し直す
                pos++
                continue
            }
            handlePayload(buf, pos + 3, payloadLen)
            pos += frameLen
        }
        // 使い残しを 前に 詰める
        if (pos > 0) {
            val rest = bufLen - pos
            if (rest > 0) System.arraycopy(buf, pos, buf, 0, rest)
            bufLen = rest
        }
    }

    private fun handlePayload(d: ByteArray, off: Int, len: Int) {
        if (len < 2) return
        val type = getBits(d, off, 0, 12).toInt()
        val now = System.currentTimeMillis()
        val st = stats.getOrPut(type) { MessageStat(firstAtMs = now) }
        st.count += 1
        st.lastAtMs = now

        try {
            when (type) {
                1005, 1006 -> parseStationArp(d, off, len, type == 1006)
                1007, 1008 -> parseAntennaDescriptor(d, off, len)
                1033 -> parseReceiverDescriptor(d, off, len)
            }
        } catch (e: Exception) {
            // 想定外の 長さでも 落とさない (次の フレームで 取り直せる)
            Log.w(TAG, "RTCM $type parse failed: ${e.message}")
        }
    }

    /**
     * 1005 / 1006: 基準局 ARP の ECEF 座標。
     * 12 種別 / 12 局ID / 6 ITRF年 / GPS,GLONASS,Galileo,基準局 各1 /
     * 38 X / 1 発振器 / 1 予約 / 38 Y / 2 quarter cycle / 38 Z [/ 16 アンテナ高]
     */
    private fun parseStationArp(d: ByteArray, off: Int, len: Int, withHeight: Boolean) {
        if (len < 19) return
        var p = 12
        stationId = getBits(d, off, p, 12).toInt(); p += 12
        p += 6 + 1 + 1 + 1 + 1
        val x = getBitsSigned(d, off, p, 38) * 0.0001; p += 38
        p += 1 + 1
        val y = getBitsSigned(d, off, p, 38) * 0.0001; p += 38
        p += 2
        val z = getBitsSigned(d, off, p, 38) * 0.0001; p += 38
        if (withHeight && len >= 21) {
            antennaHeight = getBits(d, off, p, 16) * 0.0001
        }
        val lla = ecefToLla(x, y, z)
        lat = lla[0]; lon = lla[1]; altitude = lla[2]
    }

    /** 1007 / 1008: 12 種別 / 12 局ID / 8 文字数 / アンテナ機種名 */
    private fun parseAntennaDescriptor(d: ByteArray, off: Int, len: Int) {
        if (len < 5) return
        var p = 12
        stationId = getBits(d, off, p, 12).toInt(); p += 12
        val n = getBits(d, off, p, 8).toInt(); p += 8
        antennaDescriptor = readAscii(d, off, p, n, len) ?: return
    }

    /**
     * 1033: 1007 の 中身に 続けて アンテナ製番 / 受信機機種 / ファーム / 製番。
     * どれも 8bit の 文字数 + 本体 で、すべて バイト境界に 乗る。
     */
    private fun parseReceiverDescriptor(d: ByteArray, off: Int, len: Int) {
        if (len < 5) return
        var p = 12
        stationId = getBits(d, off, p, 12).toInt(); p += 12
        val nAnt = getBits(d, off, p, 8).toInt(); p += 8
        antennaDescriptor = readAscii(d, off, p, nAnt, len) ?: return
        p += nAnt * 8
        p += 8 // アンテナ設置 ID
        val nSerial = getBits(d, off, p, 8).toInt(); p += 8
        p += nSerial * 8 // アンテナ製造番号 (使わない)
        val nRecv = getBits(d, off, p, 8).toInt(); p += 8
        receiverType = readAscii(d, off, p, nRecv, len) ?: return
        p += nRecv * 8
        val nFw = getBits(d, off, p, 8).toInt(); p += 8
        receiverFirmware = readAscii(d, off, p, nFw, len)
    }

    /** p は ビット位置。バイト境界に 乗っている 前提 (RTCM の 文字列は すべて そう) */
    private fun readAscii(d: ByteArray, off: Int, p: Int, n: Int, len: Int): String? {
        if (n <= 0) return ""
        val startByte = p / 8
        if (startByte + n > len) return null
        val sb = StringBuilder(n)
        for (i in 0 until n) {
            val c = d[off + startByte + i].toInt() and 0xFF
            // 印字可能な ASCII だけ 通す (壊れたフレームで 変な文字が 出ないように)
            if (c in 0x20..0x7E) sb.append(c.toChar())
        }
        return sb.toString()
    }

    // ------------------------------------------------------------------------
    // ビット取り出し / CRC / 座標変換
    // ------------------------------------------------------------------------

    /** off バイト目を 起点に、pos ビット目から len ビットを 符号なしで 読む */
    private fun getBits(d: ByteArray, off: Int, pos: Int, len: Int): Long {
        var v = 0L
        for (i in pos until pos + len) {
            val b = d[off + (i shr 3)].toInt() and 0xFF
            v = (v shl 1) or ((b shr (7 - (i and 7))).toLong() and 1L)
        }
        return v
    }

    /** 同上、2 の補数で 符号つき */
    private fun getBitsSigned(d: ByteArray, off: Int, pos: Int, len: Int): Long {
        val v = getBits(d, off, pos, len)
        val signBit = 1L shl (len - 1)
        return if (v and signBit != 0L) v - (1L shl len) else v
    }

    /** RTCM3 の CRC-24Q (多項式 0x1864CFB、初期値 0) */
    private fun crc24q(d: ByteArray, off: Int, len: Int): Int {
        var crc = 0
        for (i in 0 until len) {
            crc = crc xor ((d[off + i].toInt() and 0xFF) shl 16)
            repeat(8) {
                crc = crc shl 1
                if (crc and 0x1000000 != 0) crc = crc xor 0x1864CFB
            }
        }
        return crc and 0xFFFFFF
    }

    /**
     * ECEF [m] → 緯度 [deg] / 経度 [deg] / 楕円体高 [m] (WGS84)。
     * Bowring の 閉形式。測地用途でも mm 級で 合う。
     */
    private fun ecefToLla(x: Double, y: Double, z: Double): DoubleArray {
        val a = WGS84_A
        val f = WGS84_F
        val b = a * (1 - f)
        val e2 = f * (2 - f)
        val ep2 = (a * a - b * b) / (b * b)
        val p = hypot(x, y)
        if (p == 0.0) {
            // 極点。経度は 定義できないので 0 に する
            return doubleArrayOf(if (z >= 0) 90.0 else -90.0, 0.0, Math.abs(z) - b)
        }
        val th = atan2(a * z, b * p)
        val sinTh = sin(th)
        val cosTh = cos(th)
        val latRad = atan2(z + ep2 * b * sinTh * sinTh * sinTh, p - e2 * a * cosTh * cosTh * cosTh)
        val lonRad = atan2(y, x)
        val sinLat = sin(latRad)
        val n = a / sqrt(1 - e2 * sinLat * sinLat)
        val alt = p / cos(latRad) - n
        return doubleArrayOf(Math.toDegrees(latRad), Math.toDegrees(lonRad), alt)
    }
}
