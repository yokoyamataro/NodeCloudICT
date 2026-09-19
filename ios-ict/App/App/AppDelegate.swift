import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        return true
    }

    /// 計測の 音声ガイダンス (ピッ / ブッ) を 端末 本体の スピーカーから 鳴らす。
    ///
    /// 既定の カテゴリ (.soloAmbient) だと
    ///   * サイレントスイッチ ON で 無音に なる
    ///   * Bluetooth (車載 / イヤホン) に 繋がって いると そちらに 流れる
    /// ため、現場で 聞こえない ことが ある。
    ///
    /// 出力先を 本体スピーカーに 固定 できるのは .playAndRecord + .defaultToSpeaker
    /// だけ (overrideOutputAudioPort も この カテゴリ 専用)。 録音は 一切 しないが
    /// マイク 権限が 要る ため、Info.plist に その 旨を 書いて いる。
    /// .mixWithOthers を 付けて、他アプリ (音楽 / ナビ) の 再生は 止めない。
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .mixWithOthers, .allowBluetooth]
            )
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
        } catch {
            print("[audio] session setup failed: \(error)")
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // 電話や 他アプリで 音声セッションを 奪われた 後は 経路が 戻らない ことが
        // ある ので、前面に 戻る たびに 本体スピーカーに 貼り直す。
        configureAudioSession()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
