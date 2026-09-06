package net.nodecloud.ict

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.ArrayDeque
import java.util.UUID

/**
 * Drogger (RZS.D01 / RWS.DC03 など) との BLE 接続を管理する。
 * iOS の DroggerBleManager.swift と 同じ 役割・同じ 手順で 書いてある
 * (片方だけ 直して ずれるのを 防ぐため、変えるときは 両方 揃えること)。
 *
 * GATT 構成 (RZS.D01 を LightBlue で実測):
 *   Service      0BABA001-0000-1000-8000-00805F9B34FB
 *     Char 002   Notify のみ            → NMEA 受信
 *     Char 003   Read/Write/WriteNoResp → RTCM 送信・設定
 *
 * 機種によって GATT が 違う (RWS.DC03 など) ので、上の Service が 無ければ
 * 標準の Service を 除いた 中から「Notify できる 特性」と「書ける 特性」の
 * 組を 探して 同じように 使う。中身は どの機種も NMEA / RTCM の 素通しなので、
 * 通り道さえ 見つかれば 上の層は そのまま 動く。
 *
 * GATT 操作は 直列でしか 受け付けられないので、公開 API も コールバックも
 * すべて メインスレッド (handler) に 寄せて 順番を 保証する。
 */
@SuppressLint("MissingPermission") // 権限は hasScanPermission / hasConnectPermission で 自前確認
class DroggerBleManager(private val context: Context) {

    companion object {
        private const val TAG = "DroggerBle"

        /** 16bit UUID を Bluetooth Base UUID に 展開する */
        private fun uuid16(short: String): UUID =
            UUID.fromString("0000$short-0000-1000-8000-00805F9B34FB")

        val SERVICE_UUID: UUID = UUID.fromString("0BABA001-0000-1000-8000-00805F9B34FB")
        val NOTIFY_CHAR_UUID: UUID = UUID.fromString("0BABA002-0000-1000-8000-00805F9B34FB")
        val WRITE_CHAR_UUID: UUID = UUID.fromString("0BABA003-0000-1000-8000-00805F9B34FB")

        /** Client Characteristic Configuration Descriptor (Notify を 有効にする 書き込み先) */
        private val CCCD_UUID: UUID = uuid16("2902")

        /** 通り道を 探すときに 飛ばす 標準 Service (汎用属性 / 端末情報 / 電池 など) */
        private val STANDARD_SERVICE_UUIDS: Set<UUID> = setOf(
            uuid16("1800"), // Generic Access
            uuid16("1801"), // Generic Attribute
            uuid16("180A"), // Device Information
            uuid16("180F"), // Battery
            uuid16("1805"), // Current Time
            uuid16("FE59"), // DFU (Nordic)
        )

        /**
         * Drogger 系デバイス名のパターン (TS 側 DROGGER_NAME_PATTERN と揃える)
         * Drogger-XXX / DG-PRO1 / RZS.D01 / RWS.DC03 のような 名乗り方を 拾う
         */
        private val NAME_PATTERN = Regex("^(drogger|dg[-_]|rzs|rws)", RegexOption.IGNORE_CASE)

        /** 異常データで 行バッファが 無限に 膨らむのを 防ぐ */
        private const val MAX_LINE_BUFFER = 4096
        /** 受信機が 追いつかないときに RTCM が 無限に 溜まるのを 防ぐ (古い分から 捨てる) */
        private const val MAX_WRITE_QUEUE = 256
        /** これだけ 探して 見つからなければ 一度 諦めて バックオフしてから 再スキャン */
        private const val SCAN_TIMEOUT_MS = 30_000L
        /**
         * 切断してから これだけ 復帰しなければ 「切断」を UI に 伝える [ms]。
         *
         * 一瞬の 瞬断で 表示が ちらつくのは 避けたいが、受信機の 電源が 落ちた
         * ような 本当の 切断まで 黙っていると、画面が 最後の Fix (RTK-FIX 等) を
         * 出したまま 固まって 嘘に なる。短い 猶予を 置いて 見分ける。
         */
        private const val DISCONNECT_NOTICE_MS = 5_000L
        /** BLE の 既定 MTU。requestMtu が 通れば 上書きされる */
        private const val DEFAULT_MTU = 23
    }

    // ---- コールバック (プラグイン層が 差し込む) ----

    /** NMEA を 1 行受信するたびに呼ばれる (CRLF は除去済み) */
    var onNmeaLine: ((String) -> Unit)? = null
    /** 接続状態が変化したとき */
    var onStatusChange: ((Boolean, String?) -> Unit)? = null
    /** エラー発生時 (code, message) */
    var onError: ((String, String) -> Unit)? = null

    // ---- 内部状態 (すべて handler スレッドからのみ 触る) ----

    private val handler = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private var device: BluetoothDevice? = null
    /** Notify は GATT の コールバックスレッドから 読むので volatile */
    @Volatile private var notifyChar: BluetoothGattCharacteristic? = null
    private var writeChar: BluetoothGattCharacteristic? = null

    /** start(deviceAddress) で 指定された MAC (null なら 名前で 自動選択) */
    private var targetAddress: String? = null
    /** 明示的な stop() でない 切断なら 自動再接続する */
    private var shouldReconnect = false
    private var scanning = false
    private var reconnectAttempts = 0
    /** 猶予を 過ぎて 「切断」を 伝えたか (復帰するまで 二度 出さない) */
    private var disconnectNotified = false
    private var mtu = DEFAULT_MTU
    /** 応答なしで 書けない機種は 応答ありで 1 本ずつ 送る */
    private var writeTypeNoResponse = true
    /** 書き込みの 返事待ちか (GATT は 1 本ずつしか 受け付けない) */
    private var awaitingWrite = false

    /** Notify が 1 センテンス単位で 届かない場合に 備えた 行バッファ */
    private val lineBuf = ByteArray(MAX_LINE_BUFFER)
    private var lineBufLen = 0
    /** BLE の 書き込みキュー。返事が 来るまでは ここに 溜める */
    private val writeQueue = ArrayDeque<ByteArray>()
    /** スキャン中に 見かけた名前 (同じ名前を 何度も ログに 出さないため) */
    private val seenNames = HashSet<String>()

    @Volatile var isConnected: Boolean = false
        private set
    @Volatile var deviceName: String? = null
        private set

    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    // ========================================================================
    // 公開 API
    // ========================================================================

    fun start(deviceAddress: String?) {
        handler.post {
            // 既に 目的の相手に 繋がっているなら 何もしない。
            // 計測ごとに watchSamples が start() を 呼ぶため、ここで 再スキャンすると
            // 接続中の 相手を 掴み直して 接続が 一瞬切れる。
            val sameTarget = deviceAddress == null || deviceAddress == device?.address
            if (isConnected && gatt != null && sameTarget) {
                shouldReconnect = true
                onStatusChange?.invoke(true, deviceName)
                return@post
            }
            val a = adapter
            if (a == null) {
                onError?.invoke("unsupported", "この端末は Bluetooth に対応していません")
                return@post
            }
            if (!a.isEnabled) {
                onError?.invoke("bluetooth_off", "Bluetooth がオフになっています")
                return@post
            }
            // 接続手続きの 途中 / スキャン中に もう一度 呼ばれても 掴み直さない。
            // 失敗しても connectGatt が 30 秒ほどで 切断を 返すので 自力で 立て直る
            if (sameTarget && (scanning || (gatt != null && !isConnected))) {
                shouldReconnect = true
                return@post
            }
            handler.removeCallbacks(reconnectRunnable)
            targetAddress = deviceAddress
            shouldReconnect = true
            reconnectAttempts = 0
            connectOrScan()
        }
    }

    fun stop() {
        handler.post {
            shouldReconnect = false
            handler.removeCallbacks(reconnectRunnable)
            handler.removeCallbacks(scanTimeoutRunnable)
            handler.removeCallbacks(disconnectNoticeRunnable)
            disconnectNotified = false
            stopScan()
            closeGatt()
            device = null
            targetAddress = null
            resetStreamState()
            if (isConnected) {
                isConnected = false
                deviceName = null
                onStatusChange?.invoke(false, null)
            } else {
                deviceName = null
            }
        }
    }

    /**
     * RTCM3 などを 受信機へ 書き込む。BLE の MTU に 合わせて 分割送信する。
     * 返事が 来るまでは writeQueue に 溜め、onCharacteristicWrite で 続きを 流す。
     *
     * [data] は 呼び出し側で 使い回される バッファなので ここで 複製する。
     */
    fun write(data: ByteArray, len: Int) {
        if (len <= 0) return
        val copy = data.copyOf(len)
        handler.post {
            if (gatt == null || writeChar == null) return@post
            // ATT ヘッダ 3 バイトを 引いた 分が 1 回で 送れる 最大長
            val max = (mtu - 3).coerceAtLeast(20)
            var off = 0
            while (off < copy.size) {
                val end = minOf(off + max, copy.size)
                writeQueue.addLast(copy.copyOfRange(off, end))
                off = end
            }
            while (writeQueue.size > MAX_WRITE_QUEUE) writeQueue.pollFirst()
            drainWriteQueue()
        }
    }

    // ========================================================================
    // 接続 / スキャン
    // ========================================================================

    /** アドレス指定なら 直に 繋ぎ、無ければ スキャンして 名前で 探す */
    private fun connectOrScan() {
        val addr = targetAddress
        if (addr != null) {
            if (!hasConnectPermission()) {
                onError?.invoke("permission_denied", "Bluetooth の使用が許可されていません")
                return
            }
            val dev = try {
                adapter?.getRemoteDevice(addr)
            } catch (e: IllegalArgumentException) {
                null
            }
            if (dev == null) {
                onError?.invoke("connect_failed", "アドレスが 不正です: $addr")
                return
            }
            // ペアリング済み一覧から 選んだ場合は スキャンを 挟まずに 繋げる
            connectTo(dev, try { dev.name } catch (_: SecurityException) { null })
            return
        }
        beginScan()
    }

    private fun beginScan() {
        if (scanning) return
        if (!hasScanPermission()) {
            onError?.invoke("permission_denied", "Bluetooth スキャンの 権限が ありません")
            return
        }
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) {
            onError?.invoke("unsupported", "この端末は BLE に対応していません")
            return
        }
        seenNames.clear()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            // Service UUID で フィルタすると 広告に Service が 載っていない機種を
            // 拾えないため、全スキャンして 名前で 判定する。
            scanner.startScan(null, settings, scanCallback)
        } catch (e: SecurityException) {
            onError?.invoke("permission_denied", "Bluetooth スキャンが 拒否されました: ${e.message}")
            return
        }
        scanning = true
        Log.i(TAG, "scan started")
        handler.postDelayed(scanTimeoutRunnable, SCAN_TIMEOUT_MS)
    }

    private fun stopScan() {
        handler.removeCallbacks(scanTimeoutRunnable)
        if (!scanning) return
        scanning = false
        try {
            adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (e: SecurityException) {
            /* 権限が 落ちた後の stop は 無視してよい */
        }
    }

    private val scanTimeoutRunnable = Runnable {
        if (!scanning) return@Runnable
        stopScan()
        Log.w(TAG, "scan timeout: Drogger が 見つかりません")
        // 初回だけ ユーザーに 伝える (再試行中は 静かに)
        if (reconnectAttempts == 0) {
            onError?.invoke("device_not_found", "Drogger が 見つかりません")
        }
        if (shouldReconnect) scheduleReconnect()
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val dev = result.device ?: return
            val name = result.scanRecord?.deviceName
                ?: try { dev.name } catch (_: SecurityException) { null }

            // 名前が Drogger 系か、広告に Drogger の Service が 載っていれば 採用する。
            // 機種が増えても 名前を 足さずに 拾えるよう、両方を 見る
            val advertisesService =
                result.scanRecord?.serviceUuids?.any { it.uuid == SERVICE_UUID } == true
            // 繋がらないときに どんな名前で 広告しているか 分からないと 追えないので、
            // 見かけた名前を 1 回だけ 出す
            if (name != null && seenNames.add(name)) Log.i(TAG, "found: $name")
            if (!matchesDroggerName(name) && !advertisesService) return

            stopScan()
            connectTo(dev, name)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            handler.removeCallbacks(scanTimeoutRunnable)
            Log.w(TAG, "scan failed: $errorCode")
            if (reconnectAttempts == 0) {
                onError?.invoke("scan_failed", "BLE スキャンに 失敗しました (code=$errorCode)")
            }
            if (shouldReconnect) scheduleReconnect()
        }
    }

    private fun connectTo(dev: BluetoothDevice, name: String?) {
        if (!hasConnectPermission()) {
            onError?.invoke("permission_denied", "Bluetooth の使用が許可されていません")
            return
        }
        closeGatt()
        device = dev
        if (name != null) deviceName = name
        mtu = DEFAULT_MTU
        Log.i(TAG, "connecting: ${deviceName ?: dev.address}")
        gatt = try {
            dev.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } catch (e: SecurityException) {
            onError?.invoke("permission_denied", "BT 接続権限エラー: ${e.message}")
            null
        }
    }

    /** 指数バックオフ: 3s → 5s → 10s → 15s cap (SPP 版と 同じ 刻み) */
    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        reconnectAttempts += 1
        val delayMs = when {
            reconnectAttempts <= 1 -> 3_000L
            reconnectAttempts <= 3 -> 5_000L
            reconnectAttempts <= 6 -> 10_000L
            else -> 15_000L
        }
        Log.i(TAG, "reconnect in ${delayMs / 1000}s (attempt ${reconnectAttempts + 1})")
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, delayMs)
    }

    /** 猶予を 過ぎても 復帰していなければ 「切断」を 伝える */
    private val disconnectNoticeRunnable = Runnable {
        if (!isConnected && !disconnectNotified) {
            disconnectNotified = true
            Log.w(TAG, "disconnect notice: ${DISCONNECT_NOTICE_MS / 1000}s 復帰せず")
            // deviceName は 残す (どの機体に 繋いでいたかは 見せたい)
            onStatusChange?.invoke(false, deviceName)
        }
    }

    private val reconnectRunnable = Runnable {
        if (!shouldReconnect) return@Runnable
        val dev = device
        if (dev != null) connectTo(dev, deviceName) else connectOrScan()
    }

    private fun closeGatt() {
        val g = gatt ?: return
        gatt = null
        try {
            g.disconnect()
            g.close()
        } catch (e: SecurityException) {
            /* 権限が 落ちた後の close は 無視してよい */
        }
    }

    private fun resetStreamState() {
        notifyChar = null
        writeChar = null
        lineBufLen = 0
        writeQueue.clear()
        awaitingWrite = false
    }

    // ========================================================================
    // GATT コールバック
    // ========================================================================

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (g !== gatt) {
                    // 既に 捨てた 接続からの 通知
                    try { g.close() } catch (_: SecurityException) { }
                    return@post
                }
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        reconnectAttempts = 0
                        Log.i(TAG, "gatt connected (status=$status)")
                        // NMEA は 1 センテンス 80 バイト前後。既定 MTU 23 だと
                        // 細切れになって Notify の 本数が 増えるので 先に 広げる
                        val requested = try { g.requestMtu(517) } catch (_: SecurityException) { false }
                        if (!requested) {
                            try { g.discoverServices() } catch (_: SecurityException) { }
                        }
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> handleDisconnect(g, status)
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
            handler.post {
                if (g !== gatt) return@post
                mtu = if (status == BluetoothGatt.GATT_SUCCESS) newMtu else DEFAULT_MTU
                Log.i(TAG, "mtu=$mtu (status=$status)")
                try { g.discoverServices() } catch (_: SecurityException) { }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            handler.post {
                if (g !== gatt) return@post
                pickCharacteristics(g)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            handler.post {
                if (g !== gatt || d.uuid != CCCD_UUID) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "CCCD write failed (status=$status) — そのまま 待ってみる")
                }
                markConnected()
            }
        }

        // Android 13+ は 値が 引数で 渡る (それ未満は characteristic.value)
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            ch: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (ch.uuid != notifyChar?.uuid) return
            appendAndExtractLines(value)
        }

        /** API 32 以下の 経路 (33+ は 上の 3 引数版が 呼ばれる) */
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            if (ch.uuid != notifyChar?.uuid) return
            appendAndExtractLines(ch.value ?: return)
        }

        override fun onCharacteristicWrite(
            g: BluetoothGatt,
            ch: BluetoothGattCharacteristic,
            status: Int,
        ) {
            handler.post {
                if (g !== gatt) return@post
                awaitingWrite = false
                drainWriteQueue()
            }
        }
    }

    private fun handleDisconnect(g: BluetoothGatt, status: Int) {
        Log.w(TAG, "disconnected (status=$status)")
        val wasConnected = isConnected
        isConnected = false
        resetStreamState()
        closeGatt()
        // 一度も 繋がらずに 落ちた場合は 初回だけ 理由を 出す (再試行中は 静かに)
        if (!wasConnected && status != BluetoothGatt.GATT_SUCCESS && reconnectAttempts == 0) {
            onError?.invoke("connect_failed", "BLE 接続に失敗しました (status=$status)")
        }
        if (shouldReconnect) {
            // すぐには 「切断」を 出さない (瞬断での ちらつき防止)。
            // 猶予を 過ぎても 戻らなければ そこで 伝える
            Log.i(TAG, "reconnecting...")
            if (wasConnected && !disconnectNotified) {
                handler.removeCallbacks(disconnectNoticeRunnable)
                handler.postDelayed(disconnectNoticeRunnable, DISCONNECT_NOTICE_MS)
            }
            scheduleReconnect()
        } else {
            device = null
            deviceName = null
            if (wasConnected) onStatusChange?.invoke(false, null)
        }
    }

    /**
     * 既知の Drogger の Service が あれば それだけ。無い機種 (RWS.DC03 など) は
     * 標準の Service を 除いた 全部から NMEA の 通り道を 探す
     */
    private fun pickCharacteristics(g: BluetoothGatt) {
        val services = g.services ?: emptyList()
        Log.i(TAG, "services: ${services.joinToString(", ") { it.uuid.toString() }}")
        val known = services.firstOrNull { it.uuid == SERVICE_UUID }
        val targets = if (known != null) {
            listOf(known)
        } else {
            services.filter { it.uuid !in STANDARD_SERVICE_UUIDS }
        }
        if (targets.isEmpty()) {
            onError?.invoke("service_not_found", "NMEA を 流している サービスが 見つかりません")
            return
        }
        notifyChar = null
        writeChar = null
        for (s in targets) {
            for (ch in s.characteristics ?: emptyList()) {
                val props = ch.properties
                when {
                    ch.uuid == NOTIFY_CHAR_UUID -> notifyChar = ch
                    ch.uuid == WRITE_CHAR_UUID -> {
                        writeChar = ch
                        writeTypeNoResponse = props and
                            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
                    }
                    s.uuid != SERVICE_UUID -> {
                        // 未知の機種: Notify できる 特性を 受信、書ける 特性を 送信に 使う。
                        // 先に 見つかった方を 採る (どちらも 1 本しか 無いのが 普通)
                        val canNotify = props and (
                            BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                                BluetoothGattCharacteristic.PROPERTY_INDICATE
                            ) != 0
                        val canWrite = props and (
                            BluetoothGattCharacteristic.PROPERTY_WRITE or
                                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
                            ) != 0
                        if (notifyChar == null && canNotify) notifyChar = ch
                        if (writeChar == null && canWrite) {
                            writeChar = ch
                            writeTypeNoResponse = props and
                                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
                        }
                    }
                }
            }
        }
        val notify = notifyChar
        if (notify == null) {
            onError?.invoke("characteristic_not_found", "NMEA 受信用の特性が見つかりません")
            return
        }
        Log.i(TAG, "notify=${notify.uuid} write=${writeChar?.uuid ?: "-"}")
        enableNotify(g, notify)
    }

    private fun enableNotify(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
        try {
            g.setCharacteristicNotification(ch, true)
        } catch (e: SecurityException) {
            onError?.invoke("permission_denied", "Notify の 設定に 失敗: ${e.message}")
            return
        }
        val cccd = ch.getDescriptor(CCCD_UUID)
        if (cccd == null) {
            // CCCD を 持たない 実装でも Notify が 流れてくる機種が あるので 続行する
            Log.w(TAG, "CCCD なし: そのまま Notify を 待つ")
            markConnected()
            return
        }
        val value = if (ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        } else {
            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        }
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    cccd.value = value
                    g.writeDescriptor(cccd)
                }
            }
        } catch (e: SecurityException) {
            false
        }
        // 書けなかった場合も 接続自体は 生きているので 待ってみる
        if (!ok) markConnected()
    }

    private fun markConnected() {
        if (isConnected) return
        handler.removeCallbacks(disconnectNoticeRunnable)
        disconnectNotified = false
        isConnected = true
        Log.i(TAG, "BLE connected: ${deviceName ?: device?.address}")
        onStatusChange?.invoke(true, deviceName)
    }

    // ========================================================================
    // 書き込みキュー
    // ========================================================================

    /**
     * GATT は 書き込みを 1 本ずつしか 受け付けないので、返事 (onCharacteristicWrite)
     * を もらってから 次を 送る。応答なし書き込みでも この直列化は 必要。
     */
    private fun drainWriteQueue() {
        if (awaitingWrite) return
        val g = gatt ?: return
        val ch = writeChar ?: return
        val chunk = writeQueue.peekFirst() ?: return
        val type = if (writeTypeNoResponse) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, chunk, type) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    ch.writeType = type
                    ch.value = chunk
                    g.writeCharacteristic(ch)
                }
            }
        } catch (e: SecurityException) {
            false
        }
        if (ok) {
            writeQueue.pollFirst()
            awaitingWrite = true
        } else {
            // スタックが 詰まっているだけのことが 多いので 少し 待って 出し直す
            handler.postDelayed({ drainWriteQueue() }, 20L)
        }
    }

    // ========================================================================
    // 受信バイト列 → NMEA 行
    // ========================================================================

    private fun matchesDroggerName(name: String?): Boolean {
        if (name == null) return false
        return NAME_PATTERN.containsMatchIn(name)
    }

    /** 受信バイト列を CRLF/LF で行に切り出す */
    private fun appendAndExtractLines(data: ByteArray) {
        for (b in data) {
            if (b == 0x0A.toByte()) { // LF
                var end = lineBufLen
                if (end > 0 && lineBuf[end - 1] == 0x0D.toByte()) end -= 1 // CR
                val len = end
                lineBufLen = 0
                if (len > 0) {
                    onNmeaLine?.invoke(String(lineBuf, 0, len, Charsets.US_ASCII))
                }
            } else {
                // 異常データで 無限に 膨らむのを 防ぐ
                if (lineBufLen >= lineBuf.size) lineBufLen = 0
                lineBuf[lineBufLen++] = b
            }
        }
    }

    // ========================================================================
    // 権限
    // ========================================================================

    /** Android 12+ は BLUETOOTH_SCAN、それ未満は BLE スキャンに 位置情報が 要る */
    private fun hasScanPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            granted(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** Android 12+ は BLUETOOTH_CONNECT。それ未満は マニフェスト宣言だけで 足りる */
    private fun hasConnectPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            true
        }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
