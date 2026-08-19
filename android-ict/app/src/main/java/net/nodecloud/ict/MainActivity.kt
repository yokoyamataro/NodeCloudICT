package net.nodecloud.ict

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // BridgeActivity 内で loadWebView() が呼ばれる前に プラグインを登録する必要がある。
        // super.onCreate よりも前に registerPlugin を呼ぶ。
        registerPlugin(DroggerLocationPlugin::class.java)
        super.onCreate(savedInstanceState)

        // 端末の フォントサイズ設定 (設定 → ディスプレイ → フォントサイズ) を 無視して
        // 常に 100% で描画する。ユーザーが 大きめフォントに 設定していると Web の
        // レイアウトが 崩れる (文字がはみ出す / 画面外に押し出される) ため。
        try {
            bridge.webView.settings.textZoom = 100
        } catch (_: Exception) { /* WebView 未初期化 等は無視 */ }
    }
}
