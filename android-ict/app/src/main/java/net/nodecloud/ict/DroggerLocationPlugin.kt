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
    private var deviceName: String? = null
    private val running = AtomicBoolean(false)

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
        // 対象デバイス選定: 指定されていれば address 一致、無ければ 名前に "Drogger" を含む最初
        val target: BluetoothDevice? = try {
            if (deviceAddress != null) {
                adapter.bondedDevices.firstOrNull { it.address == deviceAddress }
            } else {
                adapter.bondedDevices.firstOrNull {
                    (it.name ?: "").contains("Drogger", ignoreCase = true)
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
        cleanupSocket()
        deviceName = null
        notifyStatusChange(false, null)
    }

    private fun cleanupSocket() {
        try { reader?.close() } catch (_: IOException) { /* ignore */ }
        try { socket?.close() } catch (_: IOException) { /* ignore */ }
        reader = null
        socket = null
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
        val talker = parts[0] // e.g. GNGGA / GPGGA / GNRMC / GPRMC
        try {
            when {
                talker.endsWith("GGA") -> parseGga(parts)
                talker.endsWith("RMC") -> parseRmc(parts)
                else -> return
            }
        } catch (e: Exception) {
            Log.w(TAG, "NMEA parse error on '$line': ${e.message}")
            return
        }
        emitIfReady()
    }

    private fun parseGga(parts: List<String>) {
        // $--GGA,hhmmss.ss,llll.lll,a,yyyyy.yyy,a,x,xx,x.x,x.x,M,x.x,M,x.x,xxxx*hh
        if (parts.size < 15) return
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
        if (heading != null) nmea.headingDeg = heading
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
