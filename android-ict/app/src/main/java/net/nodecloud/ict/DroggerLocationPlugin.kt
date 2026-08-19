package net.nodecloud.ict

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Drogger (RTK GNSS 受信機) からの 位置情報を Bluetooth SPP 経由で受信する
 * Capacitor プラグイン。
 *
 * TS 側契約 (src/lib/drogger.ts と一致):
 *   plugin name: 'DroggerLocation'
 *   methods:
 *     start(options?: { deviceAddress?: string })
 *     stop()
 *     getStatus()
 *     listPairedDevices()
 *   events:
 *     'location'     — DroggerLocationEvent
 *     'error'        — { code, message }
 *     'statusChange' — { connected, deviceName }
 *
 * 前提:
 * - Drogger 本体は SPP プロファイルで NMEA (GGA/RMC) をシリアル出力する
 *   ($GNGGA, $GNRMC, $GPGGA, $GPRMC のいずれか)
 * - deviceAddress 未指定時は 「名前が Drogger を含む最初のペアリング済みデバイス」を採用
 */
@CapacitorPlugin(
    name = "DroggerLocation",
    permissions = [
        Permission(
            alias = "bluetooth",
            strings = [
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN,
            ],
        ),
    ],
)
class DroggerLocationPlugin : Plugin() {
    companion object {
        private const val TAG = "DroggerLocationPlugin"
        // 標準 SPP UUID (Serial Port Profile)
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    private var socket: BluetoothSocket? = null
    private var reader: BufferedReader? = null
    private var socketOutputStream: OutputStream? = null
    /** BT SPP OutputStream への write は NMEA read 用スレッド と NTRIP RTCM 書込 の 2 者が触るので lock で直列化 */
    private val socketWriteLock = Any()
    private var deviceName: String? = null
    private val running = AtomicBoolean(false)

    // ---- NTRIP 状態 ----
    private var ntripClient: NtripClient? = null
    @Volatile private var lastRawGga: String? = null
    @Volatile private var ntripHost: String? = null
    @Volatile private var ntripMountpoint: String? = null
    /** RTCM 受信ごとの ntripStatusChange emit を 2 秒に 1 回に間引くための throttle */
    @Volatile private var lastNtripEmitAt: Long = 0L

    // ============================================================================
    // Public methods (JS bridge)
    // ============================================================================

    @PluginMethod
    fun start(call: PluginCall) {
        if (running.get()) {
            call.resolve()
            return
        }
        // Android 12+ (API 31) は BLUETOOTH_CONNECT / BLUETOOTH_SCAN が必要
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBtConnectPermission()) {
            // Capacitor 側で 権限リクエスト
            requestPermissionForAlias("bluetooth", call, "btPermissionCallback")
            return
        }
        val deviceAddress: String? = call.getString("deviceAddress")
        startInternal(call, deviceAddress)
    }

    @PermissionCallback
    @Suppress("unused")
    private fun btPermissionCallback(call: PluginCall) {
        if (!hasBtConnectPermission()) {
            call.reject("Bluetooth の権限が許可されませんでした")
            return
        }
        val deviceAddress: String? = call.getString("deviceAddress")
        startInternal(call, deviceAddress)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopInternal()
        call.resolve()
    }

    @PluginMethod
    @SuppressLint("MissingPermission")
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("connected", running.get())
        ret.put("deviceName", deviceName)
        call.resolve(ret)
    }

    @PluginMethod
    @SuppressLint("MissingPermission")
    fun listPairedDevices(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBtConnectPermission()) {
            call.reject("Bluetooth の権限がありません")
            return
        }
        val adapter = getBtAdapter()
        if (adapter == null) {
            call.reject("Bluetooth が利用できない端末です")
            return
        }
        val arr = JSArray()
        try {
            for (dev in adapter.bondedDevices) {
                val obj = JSObject()
                obj.put("name", dev.name ?: "(no name)")
                obj.put("address", dev.address)
                arr.put(obj)
            }
        } catch (e: SecurityException) {
            call.reject("Bluetooth 権限が拒否されました: ${e.message}")
            return
        }
        val ret = JSObject()
        ret.put("devices", arr)
        call.resolve(ret)
    }

    // ============================================================================
    // Internal: BT 接続 + NMEA パース ループ
    // ============================================================================

    @SuppressLint("MissingPermission")
    private fun startInternal(call: PluginCall, deviceAddress: String?) {
        val adapter = getBtAdapter()
        if (adapter == null) {
            call.reject("Bluetooth が利用できない端末です")
            return
        }
        if (!adapter.isEnabled) {
            call.reject("Bluetooth が OFF です")
            return
        }
        // 対象デバイス選定: 指定されていれば address 一致、無ければ Drogger 系名称を照合。
        //   Bizstation Drogger シリーズは "Drogger-XXX" / "DG-XXX" / "RZS.XXX" 等の
        //   複数命名パターンがあるため、下記のいずれかを含む最初のペアリング済みを採用。
        val target: BluetoothDevice? = try {
            if (deviceAddress != null) {
                adapter.bondedDevices.firstOrNull { it.address == deviceAddress }
            } else {
                adapter.bondedDevices.firstOrNull { dev ->
                    val n = (dev.name ?: "").uppercase()
                    n.contains("DROGGER") || n.startsWith("DG-") ||
                        n.startsWith("DG_") || n.startsWith("RZS")
                }
            }
        } catch (e: SecurityException) {
            call.reject("Bluetooth 権限が拒否されました: ${e.message}")
            return
        }
        if (target == null) {
            call.reject(
                if (deviceAddress != null)
                    "指定アドレスのデバイスが 見つかりません: $deviceAddress"
                else
                    "ペアリング済みの Drogger デバイスが 見つかりません"
            )
            return
        }
        deviceName = try { target.name } catch (_: SecurityException) { null }
        running.set(true)
        notifyStatusChange(true, deviceName)
        call.resolve()

        // ソケット接続 + read loop は 別スレッド
        thread(start = true, name = "DroggerReader") {
            try {
                val sock = target.createRfcommSocketToServiceRecord(SPP_UUID)
                socket = sock
                // 探索停止 (推奨)
                try { adapter.cancelDiscovery() } catch (_: SecurityException) { /* ignore */ }
                sock.connect()
                socketOutputStream = sock.outputStream
                val br = BufferedReader(InputStreamReader(sock.inputStream, Charsets.US_ASCII))
                reader = br
                while (running.get()) {
                    val line = try { br.readLine() } catch (e: IOException) {
                        if (running.get()) {
                            notifyError("io_error", "BT 受信エラー: ${e.message}")
                        }
                        null
                    } ?: break
                    handleNmeaLine(line)
                }
            } catch (e: SecurityException) {
                notifyError("permission_denied", "BT 接続権限エラー: ${e.message}")
            } catch (e: IOException) {
                notifyError("connect_failed", "BT 接続に失敗: ${e.message}")
            } finally {
                cleanupSocket()
                if (running.getAndSet(false)) {
                    notifyStatusChange(false, null)
                }
            }
        }
    }

    private fun stopInternal() {
        if (!running.getAndSet(false)) return
        // BT が切れる = RTCM の書込先が消えるので NTRIP も止める
        ntripClient?.stop()
        ntripClient = null
        cleanupSocket()
        deviceName = null
        notifyStatusChange(false, null)
    }

    private fun cleanupSocket() {
        try { reader?.close() } catch (_: IOException) { /* ignore */ }
        try { socket?.close() } catch (_: IOException) { /* ignore */ }
        reader = null
        socket = null
        socketOutputStream = null
    }

    // ============================================================================
    // NTRIP (キャスター → RTCM3 → BT SPP write) 関連 メソッド
    // ============================================================================

    @PluginMethod
    fun startNtrip(call: PluginCall) {
        val host = call.getString("host")
        val port = call.getInt("port")
        val mountpoint = call.getString("mountpoint")
        val user = call.getString("user") ?: ""
        val pass = call.getString("pass") ?: ""
        val sendGga = call.getBoolean("sendGga") ?: true
        if (host.isNullOrBlank() || port == null || mountpoint.isNullOrBlank()) {
            call.reject("host / port / mountpoint は 必須です")
            return
        }
        // 既存 client があれば停止
        ntripClient?.stop()
        ntripClient = null

        val client = NtripClient(
            host = host,
            port = port,
            mountpoint = mountpoint,
            user = user,
            pass = pass,
            sendGga = sendGga,
            onRtcm = { buf, len ->
                val out = socketOutputStream
                if (out != null) {
                    try {
                        synchronized(socketWriteLock) {
                            out.write(buf, 0, len)
                            out.flush()
                        }
                        Log.v(TAG, "RTCM → BT: $len bytes (total=${ntripClient?.bytesReceived ?: 0})")
                    } catch (e: IOException) {
                        Log.w(TAG, "RTCM write to BT failed: ${e.message}")
                    }
                } else {
                    // BT 未接続 = RTCM を捨てるしかないが、bytes カウントは進める (badge 表示用)
                    Log.v(TAG, "RTCM received but BT socket unavailable: $len bytes")
                }
                // バッジの KB カウンタ更新用に 2 秒に 1 回 status を emit
                val now = System.currentTimeMillis()
                if (now - lastNtripEmitAt > 2000) {
                    lastNtripEmitAt = now
                    notifyNtripStatus(true)
                }
            },
            onStatusChange = { connected ->
                notifyNtripStatus(connected)
            },
            onError = { code, msg ->
                notifyError(code, msg)
            },
        )
        // BT が既に接続済みなら 直近の GGA を渡す
        lastRawGga?.let { client.updateGga(it) }
        ntripClient = client
        ntripHost = host
        ntripMountpoint = mountpoint
        client.start()
        call.resolve()
    }

    @PluginMethod
    fun stopNtrip(call: PluginCall) {
        ntripClient?.stop()
        ntripClient = null
        notifyNtripStatus(false)
        call.resolve()
    }

    @PluginMethod
    fun getNtripStatus(call: PluginCall) {
        val ret = JSObject()
        val client = ntripClient
        ret.put("connected", client?.isRunning() == true)
        ret.put("host", ntripHost)
        ret.put("mountpoint", ntripMountpoint)
        ret.put("bytesReceived", client?.bytesReceived ?: 0L)
        ret.put("lastRtcmAt", client?.lastRtcmAt ?: 0L)
        call.resolve(ret)
    }

    /**
     * SourceTable を取得して mountpoint 情報を返す。
     * 別スレッドで TCP アクセスするため 非同期。
     */
    @PluginMethod
    fun fetchNtripSourceTable(call: PluginCall) {
        val host = call.getString("host")
        val port = call.getInt("port")
        val user = call.getString("user")
        val pass = call.getString("pass")
        if (host.isNullOrBlank() || port == null) {
            call.reject("host / port は 必須です")
            return
        }
        thread(start = true, name = "NtripSourceTable") {
            try {
                val raw = NtripClient.fetchSourceTable(host, port, user, pass)
                val arr = JSArray()
                for (line in raw.lineSequence()) {
                    if (!line.startsWith("STR;")) continue
                    val cols = line.split(';')
                    // STR;mountpoint;identifier;format;format-details;carrier;nav-system;network;country;lat;lng;nmea-required;solution;generator;compression;auth;fee;bitrate;misc
                    if (cols.size < 3) continue
                    val obj = JSObject()
                    obj.put("mountpoint", cols.getOrNull(1) ?: "")
                    obj.put("identifier", cols.getOrNull(2) ?: "")
                    obj.put("format", cols.getOrNull(3) ?: "")
                    obj.put("navSystem", cols.getOrNull(6) ?: "")
                    obj.put("country", cols.getOrNull(8) ?: "")
                    obj.put("nmeaRequired", (cols.getOrNull(11) ?: "0") == "1")
                    obj.put("auth", cols.getOrNull(15) ?: "N")
                    obj.put("fee", cols.getOrNull(16) ?: "N")
                    arr.put(obj)
                }
                val ret = JSObject()
                ret.put("mountpoints", arr)
                ret.put("raw", raw)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "SourceTable 取得失敗")
            }
        }
    }

    private fun notifyNtripStatus(connected: Boolean) {
        val obj = JSObject()
        obj.put("connected", connected)
        obj.put("host", ntripHost)
        obj.put("mountpoint", ntripMountpoint)
        obj.put("bytesReceived", ntripClient?.bytesReceived ?: 0L)
        obj.put("lastRtcmAt", ntripClient?.lastRtcmAt ?: 0L)
        notifyListeners("ntripStatusChange", obj)
    }

    // ============================================================================
    // NMEA 0183 パーサ
    // GGA: 時刻 / 緯度 / 経度 / fix quality / 衛星数 / HDOP / 標高 / ジオイド差
    // RMC: 時刻 / status / 緯度 / 経度 / 速度 (knots) / heading / 日付
    // ============================================================================

    /** GGA / RMC を組み合わせて 1 サンプルにまとめるための短期状態 */
    private data class NmeaBuffer(
        var lat: Double? = null,
        var lon: Double? = null,
        var altitude: Double? = null,
        var fixQuality: Int? = null,
        var satellites: Int? = null,
        var hdop: Double? = null,
        var speedKnots: Double? = null,
        var headingDeg: Double? = null,
        var timeMillis: Long? = null,
    )
    private val nmea = NmeaBuffer()

    private fun handleNmeaLine(rawLine: String) {
        val line = rawLine.trim()
        if (!line.startsWith("$")) return
        // チェックサム検証 (簡易) — 本気運用なら実装。ここではスキップ (Drogger 側で保証)
        val body = line.substringBefore('*').removePrefix("$")
        val parts = body.split(',')
        if (parts.isEmpty()) return
        val talker = parts[0] // e.g. GNGGA / GPGGA / GNRMC / GPRMC / GPGSV / GNGSA / PSAT
        try {
            when {
                talker.endsWith("GGA") -> {
                    // NTRIP VRS 用に 生 GGA を差し込む (キャスターに 定期 upload)
                    lastRawGga = line
                    ntripClient?.updateGga(line)
                    parseGga(parts)
                    emitIfReady()
                }
                talker.endsWith("RMC") -> {
                    parseRmc(parts)
                    emitIfReady()
                }
                talker.endsWith("GSV") -> parseGsv(talker, parts)
                talker.endsWith("GSA") -> parseGsa(parts)
                talker.endsWith("HDT") -> parseHdt(parts)
                talker == "PSAT" -> parsePsat(parts)
                else -> return
            }
        } catch (e: Exception) {
            Log.w(TAG, "NMEA parse error on '$line': ${e.message}")
            return
        }
    }

    private fun parseGga(parts: List<String>) {
        // $--GGA,hhmmss.ss,llll.lll,a,yyyyy.yyy,a,x,xx,x.x,x.x,M,x.x,M,x.x,xxxx*hh
        if (parts.size < 15) return
        // NMEA サイクル開始 (通常 GGA が 1 発目) → 使用中フラグを リセット
        // (以降のこのサイクルの GSA でセットされる)
        usedThisCycle.clear()
        for (sat in satMap.values) sat.usedInFix = false
        val time = parts[1]
        val lat = parseLatLon(parts[2], parts[3])
        val lon = parseLatLon(parts[4], parts[5])
        val fixQ = parts[6].toIntOrNull()
        val sats = parts[7].toIntOrNull()
        val hdop = parts[8].toDoubleOrNull()
        val alt = parts[9].toDoubleOrNull()
        if (lat != null) nmea.lat = lat
        if (lon != null) nmea.lon = lon
        if (alt != null) nmea.altitude = alt
        if (fixQ != null) nmea.fixQuality = fixQ
        if (sats != null) nmea.satellites = sats
        if (hdop != null) nmea.hdop = hdop
        if (time.isNotEmpty()) nmea.timeMillis = parseNmeaTime(time)
    }

    private fun parseRmc(parts: List<String>) {
        // $--RMC,hhmmss.ss,A,llll.lll,a,yyyyy.yyy,a,x.x,x.x,ddmmyy,x.x,a*hh
        if (parts.size < 10) return
        val speedKn = parts[7].toDoubleOrNull()
        val heading = parts[8].toDoubleOrNull()
        if (speedKn != null) nmea.speedKnots = speedKn
        if (heading != null) {
            nmea.headingDeg = heading
            // 姿勢: HDT / PSAT が来ない受信機向けの フォールバック。
            // ただし RMC の heading は Course Over Ground (移動中の進行方向) なので
            // 静止時は 意味なし。 source を "RMC (COG)" として区別。
            if (attitude.source == null || attitude.source == "RMC (COG)") {
                attitude.heading = heading
                attitude.source = "RMC (COG)"
                attitude.timestamp = System.currentTimeMillis()
                emitAttitude()
            }
        }
    }

    // ============================================================================
    // GSV / GSA パーサ (スカイマップ 用)
    //
    // 衛星ごとの (仰角 / 方位 / SNR / 使用中フラグ) を保持し、GSV グループ完了時に
    // 全 衛星のスナップショットを 'satellites' イベントで emit する。
    // ============================================================================

    private data class SatInfo(
        var constellation: String,
        var prn: Int,
        var elevation: Int? = null,
        var azimuth: Int? = null,
        var snr: Int? = null,
        var usedInFix: Boolean = false,
    )

    /** (constellation, prn) → SatInfo */
    private val satMap = LinkedHashMap<String, SatInfo>()
    /** GSV は 複数行に分割される。1 コンステレーション分の受信中状態 */
    private data class GsvGroup(val total: Int, val expected: Int, val received: MutableSet<Int>)
    private val gsvGroups = HashMap<String, GsvGroup>()
    /** GSA は 1 サイクルに 複数コンステレーション出力される。最新サイクル分の 使用中 PRN */
    private val usedThisCycle = HashSet<String>()

    /** GSV talker (GP/GL/GA/GB/GQ) → コンステレーション名 */
    private fun talkerToConst(talker: String): String = when {
        talker.startsWith("GP") -> "GPS"
        talker.startsWith("GL") -> "GLONASS"
        talker.startsWith("GA") -> "Galileo"
        talker.startsWith("GB") || talker.startsWith("BD") -> "BeiDou"
        talker.startsWith("GQ") -> "QZSS"
        talker.startsWith("GN") -> "Multi" // GN は 通常は使わない (GSV は普通 コンステレーション別)
        else -> "Other"
    }

    /** system_id (GSA の 拡張フィールド NMEA 4.10+) → コンステレーション名 */
    private fun systemIdToConst(sid: String): String? = when (sid) {
        "1" -> "GPS"
        "2" -> "GLONASS"
        "3" -> "Galileo"
        "4" -> "BeiDou"
        "5" -> "QZSS"
        else -> null
    }

    private fun parseGsv(talker: String, parts: List<String>) {
        // $--GSV,total_msgs,msg_num,sats_in_view,{prn,elev,az,snr}*4 [,signal_id]*hh
        if (parts.size < 4) return
        val totalMsgs = parts[1].toIntOrNull() ?: return
        val msgNum = parts[2].toIntOrNull() ?: return
        val satsInView = parts[3].toIntOrNull() ?: return
        val constellation = talkerToConst(talker)

        val group = gsvGroups.getOrPut(constellation) {
            GsvGroup(totalMsgs, satsInView, HashSet())
        }
        if (msgNum == 1 && group.received.isNotEmpty()) {
            // 新サイクル開始 → 前サイクルの このコンステレーションの sat を除去
            val prefix = "$constellation/"
            satMap.entries.removeAll { it.key.startsWith(prefix) }
            group.received.clear()
        }
        group.received.add(msgNum)

        // 各 GSV 行に 最大 4 衛星
        var i = 4
        while (i + 3 < parts.size) {
            val prnStr = parts[i]
            val prn = if (prnStr.isEmpty()) null else prnStr.toIntOrNull()
            if (prn != null) {
                val elev = parts[i + 1].toIntOrNull()
                val az = parts[i + 2].toIntOrNull()
                val snr = parts[i + 3].substringBefore('*').toIntOrNull()
                val key = "$constellation/$prn"
                val sat = satMap.getOrPut(key) { SatInfo(constellation, prn) }
                sat.elevation = elev
                sat.azimuth = az
                sat.snr = snr
                sat.usedInFix = usedThisCycle.contains(key)
            }
            i += 4
        }

        // 全メッセージ受信完了 → snapshot を emit + グループ状態リセット
        if (group.received.size >= totalMsgs) {
            gsvGroups.remove(constellation)
            emitSatellites()
        }
    }

    private fun parseGsa(parts: List<String>) {
        // $--GSA,mode,fix_type,prn1..prn12,pdop,hdop,vdop[,system_id]*hh
        if (parts.size < 15) return
        val systemId = if (parts.size >= 18) parts[17].substringBefore('*') else ""
        val constHint = systemIdToConst(systemId)

        // usedThisCycle は 全 GSA を跨いで蓄積 (multi-const)。GSV 側で 1st msg 時に
        // 該当コンステレーションだけリセットするので ここでは追加のみ。
        // ただし システム ID が無い/GPS 単独の場合、PRN 範囲で コンステレーションを推定。
        for (i in 2 until 14) {
            val prnStr = parts.getOrNull(i) ?: continue
            if (prnStr.isEmpty()) continue
            val prn = prnStr.toIntOrNull() ?: continue
            val c = constHint ?: prnRangeToConst(prn)
            val key = "$c/$prn"
            usedThisCycle.add(key)
            satMap[key]?.usedInFix = true
        }
    }

    /** PRN 範囲から コンステレーション推定 (system_id 未対応 受信機向けフォールバック) */
    private fun prnRangeToConst(prn: Int): String = when {
        prn in 1..32 -> "GPS"
        prn in 33..64 -> "SBAS"
        prn in 65..96 -> "GLONASS"
        prn in 193..197 -> "QZSS"
        prn in 201..235 -> "BeiDou"
        prn in 301..336 -> "Galileo"
        else -> "Other"
    }

    private fun emitSatellites() {
        val arr = JSArray()
        for (sat in satMap.values) {
            val obj = JSObject()
            obj.put("constellation", sat.constellation)
            obj.put("prn", sat.prn)
            obj.put("elevation", sat.elevation)
            obj.put("azimuth", sat.azimuth)
            obj.put("snr", sat.snr)
            obj.put("usedInFix", sat.usedInFix)
            arr.put(obj)
        }
        val ret = JSObject()
        ret.put("satellites", arr)
        ret.put("timestamp", System.currentTimeMillis())
        notifyListeners("satellites", ret)
    }

    @PluginMethod
    fun getSatellites(call: PluginCall) {
        val arr = JSArray()
        for (sat in satMap.values) {
            val obj = JSObject()
            obj.put("constellation", sat.constellation)
            obj.put("prn", sat.prn)
            obj.put("elevation", sat.elevation)
            obj.put("azimuth", sat.azimuth)
            obj.put("snr", sat.snr)
            obj.put("usedInFix", sat.usedInFix)
            arr.put(obj)
        }
        val ret = JSObject()
        ret.put("satellites", arr)
        ret.put("timestamp", System.currentTimeMillis())
        call.resolve(ret)
    }

    // ============================================================================
    // 姿勢情報 パーサ (heading / pitch / roll)
    //
    // 対応 NMEA:
    //   $--HDT,heading,T           — heading (true north)
    //   $PSAT,HPR,time,heading,pitch,roll,mode  — SIRF/Trimble/Furuno 系
    //   $--RMC の COG は "移動中の 進行方向" なので heading の フォールバックにのみ使用
    // ============================================================================

    private data class Attitude(
        var heading: Double? = null,
        var pitch: Double? = null,
        var roll: Double? = null,
        var source: String? = null,
        var timestamp: Long = 0L,
    )
    private val attitude = Attitude()

    private fun parseHdt(parts: List<String>) {
        // $--HDT,x.x,T*hh
        if (parts.size < 2) return
        val h = parts[1].toDoubleOrNull() ?: return
        attitude.heading = h
        attitude.source = "HDT"
        attitude.timestamp = System.currentTimeMillis()
        emitAttitude()
    }

    private fun parsePsat(parts: List<String>) {
        // $PSAT,HPR,time,heading,pitch,roll,mode*hh
        if (parts.size < 6) return
        if (parts[1] != "HPR") return
        val h = parts[3].toDoubleOrNull()
        val p = parts[4].toDoubleOrNull()
        val r = parts[5].toDoubleOrNull()
        if (h != null) attitude.heading = h
        if (p != null) attitude.pitch = p
        if (r != null) attitude.roll = r
        attitude.source = "PSAT/HPR"
        attitude.timestamp = System.currentTimeMillis()
        emitAttitude()
    }

    private fun emitAttitude() {
        val obj = JSObject()
        obj.put("heading", attitude.heading)
        obj.put("pitch", attitude.pitch)
        obj.put("roll", attitude.roll)
        obj.put("source", attitude.source)
        obj.put("timestamp", attitude.timestamp)
        notifyListeners("attitude", obj)
    }

    @PluginMethod
    fun getAttitude(call: PluginCall) {
        val ret = JSObject()
        ret.put("heading", attitude.heading)
        ret.put("pitch", attitude.pitch)
        ret.put("roll", attitude.roll)
        ret.put("source", attitude.source)
        ret.put("timestamp", attitude.timestamp)
        call.resolve(ret)
    }

    /** GGA/RMC の "ddmm.mmmm" + "N/S/E/W" 形式を 十進度に変換 */
    private fun parseLatLon(value: String, hemi: String): Double? {
        if (value.isEmpty() || hemi.isEmpty()) return null
        val v = value.toDoubleOrNull() ?: return null
        val deg = (v / 100).toInt()
        val min = v - deg * 100
        var dec = deg + min / 60.0
        if (hemi == "S" || hemi == "W") dec = -dec
        return dec
    }

    /** hhmmss.ss (UTC) → 現在日と組み合わせて epoch ms を返す (ざっくり) */
    private fun parseNmeaTime(hhmmss: String): Long? {
        return try {
            val hh = hhmmss.substring(0, 2).toInt()
            val mm = hhmmss.substring(2, 4).toInt()
            val ss = hhmmss.substring(4, 6).toInt()
            val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
            cal.set(java.util.Calendar.HOUR_OF_DAY, hh)
            cal.set(java.util.Calendar.MINUTE, mm)
            cal.set(java.util.Calendar.SECOND, ss)
            cal.set(java.util.Calendar.MILLISECOND, 0)
            cal.timeInMillis
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }

    /** GGA を受けた時点で lat/lon が揃っていれば 1 サンプル emit */
    private fun emitIfReady() {
        val lat = nmea.lat ?: return
        val lon = nmea.lon ?: return
        val t = nmea.timeMillis ?: System.currentTimeMillis()
        val fq = nmea.fixQuality ?: 0
        // 精度指標: GGA には Horizontal Accuracy が無いので、HDOP × 3.0m (概算) を使う。
        // 実運用では 衛星系の Manufacturer 独自メッセージ ($GNGST の std dev 等) を使うと厳密。
        val accuracy = nmea.hdop?.let { it * 3.0 } ?: -1.0
        val obj = JSObject()
        obj.put("lat", lat)
        obj.put("lon", lon)
        obj.put("accuracy_m", if (accuracy >= 0) accuracy else null)
        obj.put(
            "speed_kmh",
            nmea.speedKnots?.let { it * 1.852 } // knots → km/h
        )
        obj.put("heading_deg", nmea.headingDeg)
        obj.put("altitude_m", nmea.altitude)
        obj.put(
            "recorded_at",
            java.text.SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                java.util.Locale.US,
            ).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(t)),
        )
        obj.put("fixQuality", fq)
        obj.put("hdop", nmea.hdop)
        obj.put("satellites", nmea.satellites)
        notifyListeners("location", obj)
    }

    // ============================================================================
    // Helpers
    // ============================================================================

    private fun getBtAdapter(): BluetoothAdapter? {
        val mgr = context?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return mgr?.adapter
    }

    private fun hasBtConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val ctx = context ?: return false
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun notifyError(code: String, message: String) {
        val obj = JSObject()
        obj.put("code", code)
        obj.put("message", message)
        notifyListeners("error", obj)
    }

    private fun notifyStatusChange(connected: Boolean, deviceName: String?) {
        val obj = JSObject()
        obj.put("connected", connected)
        obj.put("deviceName", deviceName)
        notifyListeners("statusChange", obj)
    }

    override fun handleOnDestroy() {
        stopInternal()
        super.handleOnDestroy()
    }
}
