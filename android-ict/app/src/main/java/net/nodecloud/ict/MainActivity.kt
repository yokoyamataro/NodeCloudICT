package net.nodecloud.ict

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // BridgeActivity 内で loadWebView() が呼ばれる前に プラグインを登録する必要がある。
        // super.onCreate よりも前に registerPlugin を呼ぶ。
        registerPlugin(DroggerLocationPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
