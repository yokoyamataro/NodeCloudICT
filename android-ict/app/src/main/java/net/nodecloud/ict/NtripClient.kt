package net.nodecloud.ict

import android.util.Base64
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * NTRIP 1.0/2.0 クライアント。RTCM3 補正を キャスターから TCP で受信して
 * onRtcm コールバックで通知する。
 *
 * プロトコル:
 * - GET /MOUNTPOINT HTTP/1.0 + Basic 認証ヘッダ
 * - "ICY 200 OK" (旧式) or "HTTP/1.1 200 OK" (新式) 応答後は RTCM3 バイナリ
 * - SourceTable 取得は 空 mountpoint で GET / HTTP/1.0
 * - VRS (電子基準点/民間サービス) は 定期的に 最新 GGA を キャスターへ upload 必須
 *
 * 受信機への 書き込み (BLE) は 呼出側で行う (onRtcm 内)。
 * NtripClient 自体は Drogger BT を知らない = 単純な NTRIP → callback。
 */
class NtripClient(
    private val host: String,
    private val port: Int,
    private val mountpoint: String,
    private val user: String,
    private val pass: String,
    /** VRS 用: 定期的に latestGga を キャスターへ upload */
    private val sendGga: Boolean,
    private val onRtcm: (ByteArray, Int) -> Unit,
    private val onStatusChange: (Boolean) -> Unit,
    private val onError: (String, String) -> Unit,
) {
    companion object {
        private const val TAG = "NtripClient"
        private const val GGA_INTERVAL_MS = 10_000L
        private const val CONNECT_TIMEOUT_MS = 10_000
        // 90 秒: 通常 RTCM は 1 秒毎に来るが、ネットワーク瞬断や 一時的遅延に 耐性を持たせる
        private const val READ_TIMEOUT_MS = 90_000

        /**
         * SourceTable を取得。生テキスト (STR;/CAS;/NET; 行) を返し、パースは呼出側。
         */
        @Throws(IOException::class)
        fun fetchSourceTable(
            host: String,
            port: Int,
            user: String?,
            pass: String?,
            timeoutMs: Int = 10_000,
        ): String {
            val sock = Socket()
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            sock.soTimeout = timeoutMs
            try {
                val req = buildString {
                    append("GET / HTTP/1.0\r\n")
                    append("User-Agent: NTRIP NodeCloudICT/1.0\r\n")
                    if (!user.isNullOrEmpty()) {
                        val cred = Base64.encodeToString(
                            "$user:$pass".toByteArray(Charsets.UTF_8),
                            Base64.NO_WRAP,
                        )
                        append("Authorization: Basic $cred\r\n")
                    }
                    append("Accept: */*\r\n")
                    append("Connection: close\r\n")
                    append("\r\n")
                }
                sock.outputStream.write(req.toByteArray(Charsets.US_ASCII))
                sock.outputStream.flush()
                val ins = sock.inputStream
                val first = readAsciiLine(ins) ?: throw IOException("SourceTable 応答なし")
                if (!(first.startsWith("SOURCETABLE 200 OK") ||
                        (first.startsWith("HTTP/1.") && first.contains(" 200 ")))) {
                    throw IOException("SourceTable 取得失敗: $first")
                }
                // ヘッダを空行まで捨てる
                while (true) {
                    val h = readAsciiLine(ins) ?: break
                    if (h.isEmpty()) break
                }
                val sb = StringBuilder()
                while (true) {
                    val body = readAsciiLine(ins) ?: break
                    if (body.startsWith("ENDSOURCETABLE")) break
                    sb.append(body).append('\n')
                }
                return sb.toString()
            } finally {
                try { sock.close() } catch (_: IOException) { /* ignore */ }
            }
        }

        /** 1 行 ASCII 読み込み (\r\n 区切り) */
        private fun readAsciiLine(ins: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val b = ins.read()
                if (b < 0) return if (sb.isEmpty()) null else sb.toString()
                if (b == '\n'.code) {
                    if (sb.isNotEmpty() && sb.last() == '\r') sb.deleteCharAt(sb.length - 1)
                    return sb.toString()
                }
                sb.append(b.toChar())
                if (sb.length > 8192) return sb.toString()
            }
        }
    }

    private val running = AtomicBoolean(false)
    private var socket: Socket? = null
    private var readerThread: Thread? = null
    private var ggaThread: Thread? = null
    @Volatile private var latestGga: String? = null
    @Volatile var bytesReceived: Long = 0L
        private set
    @Volatile var lastRtcmAt: Long = 0L
        private set

    /** 呼出側 (DroggerLocationPlugin) が GGA を受信したら 最新版を差し込む */
    fun updateGga(ggaLine: String) {
        latestGga = ggaLine
    }

    fun start() {
        if (running.getAndSet(true)) return
        Log.i(TAG, "NtripClient.start() host=$host:$port mount=$mountpoint sendGga=$sendGga")
        readerThread = thread(start = true, name = "NtripReader") {
            var reconnectAttempts = 0
            var unrecoverable = false
            while (running.get() && !unrecoverable) {
                try {
                    connectAndStream()
                    // 正常終了 (running=false) or EOF で 抜けてきた
                    if (!running.get()) break
                    // EOF (キャスターが 接続閉じた) → 再接続へ
                } catch (e: Exception) {
                    if (!running.get()) break
                    val cls = e.javaClass.simpleName
                    val msg = e.message ?: "no message"
                    val hint = when (e) {
                        is java.net.UnknownHostException ->
                            " (DNS 解決失敗 - hostname のスペル 又は Wi-Fi/モバイルデータ接続を確認)"
                        is java.net.ConnectException ->
                            " (接続拒否 - port が違うか キャスター停止中)"
                        is java.net.SocketTimeoutException ->
                            " (タイムアウト - キャスターの応答なし)"
                        else -> ""
                    }
                    // 認証失敗 / mountpoint 不在 は 再接続しても 治らない
                    val isFatal = msg.contains("認証失敗") || msg.contains("見つかりません")
                    Log.w(TAG, "NTRIP error (attempt ${reconnectAttempts + 1}): $cls: $msg$hint")
                    if (reconnectAttempts == 0) {
                        // 初回のみ ユーザーに 通知
                        onError("ntrip_io", "$cls: $msg$hint")
                    }
                    if (isFatal) {
                        unrecoverable = true
                    }
                }
                cleanup()
                if (!running.get() || unrecoverable) break
                onStatusChange(false)
                reconnectAttempts += 1
                val delayMs = when {
                    reconnectAttempts <= 1 -> 3000L
                    reconnectAttempts <= 3 -> 5000L
                    reconnectAttempts <= 6 -> 10000L
                    else -> 15000L
                }
                Log.i(TAG, "NTRIP reconnect in ${delayMs / 1000}s (attempt ${reconnectAttempts + 1})")
                try { Thread.sleep(delayMs) } catch (_: InterruptedException) { break }
            }
            cleanup()
            if (running.getAndSet(false)) {
                onStatusChange(false)
            }
            Log.i(TAG, "NtripReader thread exit")
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        cleanup()
        onStatusChange(false)
    }

    fun isRunning(): Boolean = running.get()

    @Throws(IOException::class)
    private fun connectAndStream() {
        Log.d(TAG, "NTRIP TCP connect start: $host:$port")
        val sock = Socket()
        sock.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        sock.soTimeout = READ_TIMEOUT_MS
        socket = sock
        Log.d(TAG, "NTRIP TCP connected (localAddr=${sock.localAddress})")

        val mp = if (mountpoint.startsWith("/")) mountpoint else "/$mountpoint"
        val cred = Base64.encodeToString(
            "$user:$pass".toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP,
        )
        val req = buildString {
            append("GET $mp HTTP/1.0\r\n")
            append("User-Agent: NTRIP NodeCloudICT/1.0\r\n")
            append("Accept: */*\r\n")
            append("Connection: close\r\n")
            append("Authorization: Basic $cred\r\n")
            append("Ntrip-Version: Ntrip/2.0\r\n")
            append("\r\n")
        }
        Log.d(TAG, "NTRIP sending request to $mp")
        sock.outputStream.write(req.toByteArray(Charsets.US_ASCII))
        sock.outputStream.flush()

        val ins = sock.inputStream
        val first = readAsciiLine(ins) ?: throw IOException("NTRIP 応答なし")
        Log.i(TAG, "NTRIP first line: $first")
        when {
            first.startsWith("ICY 200 OK") -> { /* NTRIP 1.0: 追加ヘッダなし */ }
            first.startsWith("HTTP/1.") && first.contains(" 200 ") -> {
                // NTRIP 2.0 / HTTP: ヘッダを 空行まで読み捨て
                while (true) {
                    val h = readAsciiLine(ins) ?: break
                    if (h.isEmpty()) break
                }
            }
            first.contains(" 401") -> throw IOException("NTRIP 認証失敗 (user/pass を確認)")
            first.contains(" 404") -> throw IOException("NTRIP mountpoint が 見つかりません: $mp")
            first.startsWith("SOURCETABLE") ->
                throw IOException("mountpoint 未指定 (SourceTable 応答)")
            else -> throw IOException("NTRIP 応答 不明: $first")
        }
        onStatusChange(true)

        // GGA upload thread (VRS 用)
        if (sendGga) {
            val out: OutputStream = sock.outputStream
            ggaThread = thread(start = true, name = "NtripGgaSender") {
                try {
                    // 最初の GGA は 接続直後に一度だけ 待ちなしで送る (VRS の 初回位置指示)
                    Thread.sleep(2_000)
                    while (running.get()) {
                        val g = latestGga
                        if (g != null) {
                            val line = if (g.endsWith("\r\n")) g else "$g\r\n"
                            try {
                                synchronized(out) {
                                    out.write(line.toByteArray(Charsets.US_ASCII))
                                    out.flush()
                                }
                                Log.d(TAG, "GGA uploaded to caster: ${g.take(80)}")
                            } catch (e: IOException) {
                                Log.w(TAG, "GGA upload failed: ${e.message}")
                                break
                            }
                        } else {
                            Log.d(TAG, "GGA upload skipped: latestGga is null (Drogger 未接続 or GGA未受信)")
                        }
                        Thread.sleep(GGA_INTERVAL_MS)
                    }
                } catch (_: InterruptedException) { /* stop */ }
            }
        } else {
            Log.d(TAG, "GGA upload disabled (sendGga=false)")
        }

        Log.d(TAG, "NTRIP stream started, waiting for RTCM3 bytes...")

        // RTCM3 受信ループ
        val buf = ByteArray(4096)
        var firstBytesLogged = false
        while (running.get()) {
            val n = try {
                ins.read(buf)
            } catch (e: IOException) {
                if (running.get()) throw e else -1
            }
            if (n < 0) {
                Log.w(TAG, "NTRIP socket EOF (caster closed connection after ${bytesReceived} bytes)")
                break
            }
            if (n > 0) {
                if (!firstBytesLogged) {
                    firstBytesLogged = true
                    val head = buf.take(minOf(n, 8)).joinToString(" ") { "%02X".format(it) }
                    Log.i(TAG, "NTRIP first RTCM bytes: $head (n=$n)")
                }
                bytesReceived += n
                lastRtcmAt = System.currentTimeMillis()
                onRtcm(buf, n)
            }
        }
    }

    private fun cleanup() {
        try { socket?.close() } catch (_: IOException) { /* ignore */ }
        socket = null
        ggaThread?.interrupt()
        ggaThread = null
    }
}
