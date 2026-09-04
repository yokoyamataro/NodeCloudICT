package net.nodecloud.ict

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
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
import kotlin.concurrent.thread

/**
 * Drogger (RTK GNSS 受信機) からの 位置情報を BLE (GATT) 経由で受信する
 * Capacitor プラグイン。接続そのものは DroggerBleManager が 受け持つ。
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
 * - Drogger 本体は BLE の Notify で NMEA (GGA/RMC 等) を 素通しする
 *   ($GNGGA, $GNRMC, $GPGGA, $GPRMC のいずれか)
 * - deviceAddress 未指定時は BLE スキャンで「名前が Drogger 系の 最初のデバイス」を採用
 * - 旧 SPP (RFCOMM) 経路は 廃止。RWS.DC03 のような BLE 専用機に 合わせ、
 *   iOS 版と 同じ BLE 一本に 揃えてある
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
        // Android 11 以下は BLE スキャン結果を 受け取るのに 位置情報の 権限が 要る
        Permission(
            alias = "bluetoothLegacy",
            strings = [Manifest.permission.ACCESS_FINE_LOCATION],
        ),
    ],
)
class DroggerLocationPlugin : Plugin() {
    companion object {
        private const val TAG = "DroggerLocationPlugin"
    }

    /**
     * BLE (GATT) 接続の 本体。NMEA の 行組み立て・再接続・RTCM の 分割送信は
     * すべて こちらが 持つ。iOS 版 DroggerBleManager.swift と 同じ 分担。
     */
    private val ble: DroggerBleManager by lazy {
        DroggerBleManager(context).also { m ->
            // BLE の コールバックスレッドで 呼ばれる (旧 SPP の read スレッドと 同じ扱い)
            m.onNmeaLine = { line -> handleNmeaLine(line) }
            m.onStatusChange = { connected, name -> notifyStatusChange(connected, name) }
            m.onError = { code, message -> notifyError(code, message) }
        }
    }

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
        // Android 12+ (API 31) は BLUETOOTH_SCAN / BLUETOOTH_CONNECT が ランタイム権限。
        // それ未満は BLE スキャン結果を 受け取るのに 位置情報の 権限が 要る
        if (!hasBtPermissions()) {
            val alias =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "bluetooth" else "bluetoothLegacy"
            requestPermissionForAlias(alias, call, "btPermissionCallback")
            return
        }
        // 実際に 繋がったかは statusChange イベントで 伝わる (iOS 版と 同じ)
        ble.start(call.getString("deviceAddress"))
        call.resolve()
    }

    @PermissionCallback
    @Suppress("unused")
    private fun btPermissionCallback(call: PluginCall) {
        if (!hasBtPermissions()) {
            call.reject("Bluetooth の権限が許可されませんでした")
            return
        }
        ble.start(call.getString("deviceAddress"))
        call.resolve()
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
        ret.put("connected", ble.isConnected)
        ret.put("deviceName", ble.deviceName)
        call.resolve(ret)
    }

    /**
     * ペアリング済み デバイス一覧。BLE は ペアリング無しでも 繋がるので 必須では ないが、
     * ここで 返す MAC は そのまま start({ deviceAddress }) に 渡せる
     * (スキャンを 挟まずに 直接 繋ぎに いける)。
     */
    @PluginMethod
    @SuppressLint("MissingPermission")
    fun listPairedDevices(call: PluginCall) {
        if (!hasBtConnectPermission()) {
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
    // Internal: 接続の 開始 / 終了
    // ============================================================================

    private fun stopInternal() {
        // BLE が切れる = RTCM の書込先が消えるので NTRIP も止める
        ntripClient?.stop()
        ntripClient = null
        // statusChange(false) は DroggerBleManager 側が 出す
        ble.stop()
    }

    // ============================================================================
    // NTRIP (キャスター → RTCM3 → BLE write) 関連 メソッド
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
                if (ble.isConnected) {
                    // MTU に 合わせた 分割と 送信順の 直列化は BLE 側の キューが 面倒を 見る
                    ble.write(buf, len)
                } else {
                    // BLE 未接続 = RTCM を捨てるしかないが、bytes カウントは進める (badge 表示用)
                    Log.v(TAG, "RTCM received but BLE unavailable: $len bytes")
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

    /** GGA / RMC / GST を組み合わせて 1 サンプルにまとめるための短期状態 */
    private data class NmeaBuffer(
        var lat: Double? = null,
        var lon: Double? = null,
        /** GGA field 9: 受信機内蔵ジオイド (通常 EGM96) 基準の MSL 標高 [m] */
        var altitude: Double? = null,
        /** GGA field 11: geoidal separation = WGS84 楕円体 − 受信機内蔵ジオイド [m]
         *  楕円体高 h = altitude + geoidalSep で 求まる */
        var geoidalSep: Double? = null,
        var fixQuality: Int? = null,
        var satellites: Int? = null,
        var hdop: Double? = null,
        var speedKnots: Double? = null,
        var headingDeg: Double? = null,
        var timeMillis: Long? = null,
        // GST 由来: RTK 受信機の std dev (メートル)。これがあれば HDOP × 3 より 正確
        var stdLat: Double? = null,
        var stdLon: Double? = null,
        var stdAlt: Double? = null,
        /** GGA field 13: 補正データを 受け取ってからの 経過時間 [s]。補正なしは 空欄 */
        var diffAge: Double? = null,
        /** GGA field 14: 差分基準局 ID。NTRIP は 基準局の 番号、CLAS は 受信機内で
         *  解くので 固定値になる */
        var stationId: String? = null,
    )
    private val nmea = NmeaBuffer()

    private val seenTalkers = HashSet<String>()
    private val talkerCounts = HashMap<String, Int>()
    private var lastTalkerSummaryMs: Long = 0L

    private fun handleNmeaLine(rawLine: String) {
        val line = rawLine.trim()
        if (!line.startsWith("$")) return
        // チェックサム検証 (簡易) — 本気運用なら実装。ここではスキップ (Drogger 側で保証)
        val body = line.substringBefore('*').removePrefix("$")
        val parts = body.split(',')
        if (parts.isEmpty()) return
        val talker = parts[0] // e.g. GNGGA / GPGGA / GNRMC / GPRMC / GPGSV / GNGSA / PSAT
        // 診断: 見た NMEA sentence 種類 と 出現回数を 5 秒毎に集計 log
        if (seenTalkers.add(talker)) {
            Log.i(TAG, "NEW NMEA sentence type: \$$talker  first=$line")
        }
        talkerCounts[talker] = (talkerCounts[talker] ?: 0) + 1
        val now = System.currentTimeMillis()
        if (now - lastTalkerSummaryMs > 5000) {
            lastTalkerSummaryMs = now
            Log.i(TAG, "NMEA counts (last 5s+): $talkerCounts")
            talkerCounts.clear()
        }
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
                talker.endsWith("GST") -> parseGst(parts)
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
        //   1    2         3        4 5         6 7 8  9   10 11 12 13 14
        //                                             ↑    ↑  ↑ (10) ↑ (11) geoidal_sep
        //                                          altitude M   geoidal_sep M ...
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
        val geoidSep = parts[11].toDoubleOrNull() // 受信機内蔵ジオイドとの差 (m)
        if (lat != null) nmea.lat = lat
        if (lon != null) nmea.lon = lon
        if (alt != null) nmea.altitude = alt
        if (geoidSep != null) nmea.geoidalSep = geoidSep
        if (fixQ != null) nmea.fixQuality = fixQ
        if (sats != null) nmea.satellites = sats
        if (hdop != null) nmea.hdop = hdop
        // GGA field 13 / 14: 補正の 経過時間 [s] と 差分基準局 ID。
        // CLAS か NTRIP かの 見分けに 使う (どちらも 品質は 4 / 5 で 同じ)。
        // 補正が 無い間は 空欄なので、その時は null に 戻す
        nmea.diffAge = parts[13].toDoubleOrNull()
        nmea.stationId = parts[14].trim().ifEmpty { null }
        if (time.isNotEmpty()) nmea.timeMillis = parseNmeaTime(time)
    }

    private fun parseGst(parts: List<String>) {
        // $--GST,time,rms,semi_major,semi_minor,orientation,std_lat,std_lon,std_alt*cs
        // RTK 受信機は これで cm オーダーの std dev を くれる
        // 一部受信機は std_alt を省略 (8 フィールド) するので lat/lon が読めれば OK
        if (parts.size < 8) {
            Log.w(TAG, "GST too short: size=${parts.size} parts=$parts")
            return
        }
        val sLat = parts[6].toDoubleOrNull()
        val sLon = parts[7].toDoubleOrNull()
        val sAlt = if (parts.size >= 9) parts[8].substringBefore('*').toDoubleOrNull() else null
        if (sLat != null) nmea.stdLat = sLat
        if (sLon != null) nmea.stdLon = sLon
        if (sAlt != null) nmea.stdAlt = sAlt
        Log.v(TAG, "GST parsed: stdLat=$sLat stdLon=$sLon stdAlt=$sAlt")
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
        var lastSeenMs: Long = 0L,
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
        val talkerConst = talkerToConst(talker)
        // $GNGSV (multi-constellation) の場合、衛星ごとに PRN 範囲から
        // コンステレーションを決定する。これは GSA が PRN 範囲から const 判定
        // するのと 揃える必要がある (使用中フラグの key マッチのため)。
        val isMultiTalker = talker.startsWith("GN")

        // グループ追跡は talker 単位 (multi でも 単一 talker として 扱う)
        val group = gsvGroups.getOrPut(talker) {
            GsvGroup(totalMsgs, satsInView, HashSet())
        }
        if (msgNum == 1 && group.received.isNotEmpty()) {
            // 新サイクル開始:
            //   単一 talker (GPGSV 等) は そのコンステレーションの 前サイクル分を除去
            //   multi talker (GNGSV) は 対象コンステレーションが 特定できないので
            //   除去しない (上書きに任せる)
            if (!isMultiTalker) {
                val prefix = "$talkerConst/"
                satMap.entries.removeAll { it.key.startsWith(prefix) }
            }
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
                // multi の場合は PRN 範囲で 個別に判定 (GSA と key を揃えるため)
                val constellation = if (isMultiTalker) prnRangeToConst(prn) else talkerConst
                val key = "$constellation/$prn"
                val sat = satMap.getOrPut(key) { SatInfo(constellation, prn) }
                sat.elevation = elev
                sat.azimuth = az
                sat.snr = snr
                sat.usedInFix = usedThisCycle.contains(key)
                sat.lastSeenMs = System.currentTimeMillis()
            }
            i += 4
        }

        // 全メッセージ受信完了 → snapshot を emit + グループ状態リセット
        if (group.received.size >= totalMsgs) {
            gsvGroups.remove(talker)
            // 3 秒以上見なかった 衛星は 古いエントリなので 除去
            // (multi talker で リセットしない ぶん、ここで 蓄積を防ぐ)
            val cutoff = System.currentTimeMillis() - 3000
            satMap.entries.removeAll { it.value.lastSeenMs > 0 && it.value.lastSeenMs < cutoff }
            emitSatellites()
        }
    }

    private fun parseGsa(parts: List<String>) {
        // $--GSA,mode,fix_type,prn1..prn12,pdop,hdop,vdop[,system_id]*hh
        // インデックス: 0=talker, 1=mode, 2=fix_type, 3..14=PRN×12, 15=PDOP,
        //              16=HDOP, 17=VDOP, [18=system_id]
        if (parts.size < 15) return
        val systemId = if (parts.size >= 19) parts[18].substringBefore('*') else ""
        val constHint = systemIdToConst(systemId)

        var changed = false
        var markedPrns = 0
        var missingInSatMap = 0
        // PRN は index 3..14 (12 個)。以前 2..13 で fix_type を PRN 扱いしていた 不具合を修正
        for (i in 3 until 15) {
            val prnStr = parts.getOrNull(i) ?: continue
            if (prnStr.isEmpty()) continue
            val prn = prnStr.toIntOrNull() ?: continue
            val c = constHint ?: prnRangeToConst(prn)
            val key = "$c/$prn"
            usedThisCycle.add(key)
            markedPrns += 1
            val sat = satMap[key]
            if (sat != null) {
                if (!sat.usedInFix) {
                    sat.usedInFix = true
                    changed = true
                }
            } else {
                missingInSatMap += 1
            }
        }
        Log.v(TAG, "GSA parsed: sysId='$systemId' constHint=$constHint markedPrns=$markedPrns missingInSatMap=$missingInSatMap changed=$changed satMapSize=${satMap.size}")
        // GSV グループ完了に頼らず、GSA で usedInFix が 変わったら 都度 emit。
        // これが無いと 「使用中 0/N」表示になる (GSA が satMap を更新しても UI に伝わらない)
        if (changed) emitSatellites()
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

    /**
     * usedInFix を 決定する。
     *   GSA (usedThisCycle) が 来ていれば それを 信じる (正確)
     *   来ていなければ SNR 上位 N 個 (N=GGA field 7 の 使用数) を 使用中と推定
     */
    private fun computeUsedInFix() {
        val hasGsa = usedThisCycle.isNotEmpty()
        if (hasGsa) {
            // GSA が有る場合: parseGsa の 時点で 既に satMap.usedInFix は 設定済み
            // ここでは 何もしないで OK (usedThisCycle に無い entry は false のまま)
            for (sat in satMap.values) {
                sat.usedInFix = usedThisCycle.contains("${sat.constellation}/${sat.prn}")
            }
            return
        }
        // GSA 無い場合: SNR 上位 N 個 を 使用中と 推定
        val n = nmea.satellites ?: 0
        if (n <= 0) {
            for (sat in satMap.values) sat.usedInFix = false
            return
        }
        // SNR が null の 衛星は 除外 (-1 で 末尾)。SNR 降順で 並べる。
        val sorted = satMap.values.sortedByDescending { it.snr ?: -1 }
        for ((idx, sat) in sorted.withIndex()) {
            sat.usedInFix = idx < n && (sat.snr ?: -1) > 0
        }
    }

    /**
     * 衛星スナップショットを 送る 間隔 [ms]。
     * GSV / GSA は 1 秒ごとに 来るが、スカイマップは そんなに 速く 動かなくてよい。
     * 毎回 送ると ブリッジ越しの 更新と 再描画が 無駄に 回る。
     */
    private val satelliteEmitIntervalMs = 5000L
    private var lastSatEmitMs = 0L

    /** 衛星スナップショットを 送る。間隔を 空けて 間引く
     *  (getSatellites() で 引くときは いつでも 最新が 返る) */
    private fun emitSatellites() {
        val now = System.currentTimeMillis()
        if (now - lastSatEmitMs < satelliteEmitIntervalMs) return
        lastSatEmitMs = now
        computeUsedInFix()
        val arr = JSArray()
        var usedCount = 0
        for (sat in satMap.values) {
            val obj = JSObject()
            obj.put("constellation", sat.constellation)
            obj.put("prn", sat.prn)
            obj.put("elevation", sat.elevation)
            obj.put("azimuth", sat.azimuth)
            obj.put("snr", sat.snr)
            obj.put("usedInFix", sat.usedInFix)
            arr.put(obj)
            if (sat.usedInFix) usedCount += 1
        }
        Log.v(TAG, "emitSatellites: total=${satMap.size} used=$usedCount cycle=${usedThisCycle.size} ggaSats=${nmea.satellites}")
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
        // 水平精度: 優先順位で採用
        //   1. GST があれば sqrt(σ_lat² + σ_lon²) (RTK Fix 時に cm オーダーの正確値)
        //   2. Fix Quality ベースの 典型値 (受信機が GST を出さない場合の 妥当な推定)
        //      fq=4 (RTK Fix): 0.02m / fq=5 (RTK Float): 0.30m
        //      fq=2 (DGPS): 1.0m / fq=1 (SPS): 3.0m
        //   3. HDOP × 3.0m の 概算 (fq=0 の 最終フォールバック)
        val useGst = nmea.stdLat != null && nmea.stdLon != null
        val fqTypicalAcc: Double? = when (fq) {
            4 -> 0.02
            5 -> 0.30
            2 -> 1.0
            1 -> 3.0
            else -> null
        }
        val hAcc = if (useGst) {
            val sLat = nmea.stdLat!!
            val sLon = nmea.stdLon!!
            Math.sqrt(sLat * sLat + sLon * sLon)
        } else fqTypicalAcc ?: (nmea.hdop?.let { it * 3.0 } ?: -1.0)
        val accSrc = when {
            useGst -> "GST"
            fqTypicalAcc != null -> "FQ($fq)"
            else -> "HDOP×3"
        }
        // 頻度が高いので Log.v (デフォルト非表示)。必要なら logcat 側で level 上げる
        // 垂直精度:
        //   1. GST の std_alt を優先
        //   2. fq ベース (水平の 1.5〜2 倍が 一般的): fq=4→0.03m / fq=5→0.5m / fq=2→2m / fq=1→5m
        //   3. HDOP × 5.0m フォールバック
        val fqTypicalVAcc: Double? = when (fq) {
            4 -> 0.03
            5 -> 0.50
            2 -> 2.0
            1 -> 5.0
            else -> null
        }
        val vAcc = nmea.stdAlt ?: fqTypicalVAcc ?: nmea.hdop?.let { it * 5.0 } ?: -1.0
        val obj = JSObject()
        obj.put("lat", lat)
        obj.put("lon", lon)
        obj.put("accuracy_m", if (hAcc >= 0) hAcc else null)
        obj.put("altitude_accuracy_m", if (vAcc >= 0) vAcc else null)
        obj.put(
            "speed_kmh",
            nmea.speedKnots?.let { it * 1.852 } // knots → km/h
        )
        obj.put("heading_deg", nmea.headingDeg)
        obj.put("altitude_m", nmea.altitude)
        // GGA field 11: 受信機内蔵ジオイド と WGS84 楕円体 の 差 [m]
        // TS 側で 楕円体高 = altitude_m + geoidal_separation_m を計算し、
        // JPGEO2024 を 引いて 正確な MSL 標高 を 求めるために 必要
        obj.put("geoidal_separation_m", nmea.geoidalSep)
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
        // 補正の 出どころ判定用 (TS 側 correctionSource)
        obj.put("diffAge", nmea.diffAge)
        obj.put("stationId", nmea.stationId)
        // 精度が 実測 (GST) なのか 品質ごとの 典型値なのかを UI にも 渡す
        obj.put("accuracySource", accSrc)
        notifyListeners("location", obj)
    }

    // ============================================================================
    // Helpers
    // ============================================================================

    private fun getBtAdapter(): BluetoothAdapter? {
        val mgr = context?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return mgr?.adapter
    }

    /** Android 12+ は BLUETOOTH_CONNECT。それ未満は マニフェスト宣言だけで 足りる */
    private fun hasBtConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return granted(Manifest.permission.BLUETOOTH_CONNECT)
    }

    /**
     * BLE で 繋ぐのに 要る 権限が 揃っているか。
     * Android 12+ は SCAN + CONNECT、それ未満は スキャン結果を 受け取るための 位置情報。
     */
    private fun hasBtPermissions(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN) &&
                granted(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun granted(permission: String): Boolean {
        val ctx = context ?: return false
        return ContextCompat.checkSelfPermission(ctx, permission) ==
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
