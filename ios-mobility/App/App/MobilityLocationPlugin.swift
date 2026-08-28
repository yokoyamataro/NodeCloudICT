import Foundation
import UIKit
import Capacitor
import CoreLocation
import UserNotifications
import ActivityKit

/// バックグラウンド位置送信の iOS 実装。
///
/// @capacitor-community/background-geolocation は capacitor-swift-pm 7.x 固定で
/// Capacitor 8 と依存解決できないため、同じ JS 名 ("BackgroundGeolocation") と
/// 同じメソッド (addWatcher / removeWatcher / openSettings) を自前で実装して
/// 置き換える。TS 側 (src/lib/geolocation.ts) は
///
///     registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
///
/// で名前解決しているだけなので、TS は 1 行も変更しない。
///
/// 契約は本家 (node_modules/@capacitor-community/background-geolocation の
/// ios/Plugin/Swift/Plugin.swift) に合わせている。特に:
///
///   * CLLocationManager の操作は必ずメインスレッド。Capacitor のプラグイン
///     呼び出しはバックグラウンドキューで来るため、ここを外すと位置更新が
///     一度も届かない。
///   * watcher の id は call.callbackId。addWatcher は位置以外を resolve しない。
///     resolve するたびに JS 側のコールバックが呼ばれるので、id を resolve すると
///     位置情報のつもりで別のオブジェクトが流れてしまう。
///   * distanceFilter = 0 は以降の更新が止まることがあるので
///     kCLDistanceFilterNone にする (本家 issue #88)。
@objc(MobilityLocationPlugin)
public class MobilityLocationPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "MobilityLocationPlugin"
    // ここが TS の registerPlugin 名と一致している必要がある
    public let jsName = "BackgroundGeolocation"
    public let pluginMethods: [CAPPluginMethod] = [
        // addWatcher は位置が更新されるたびに呼び返すので Callback 型
        CAPPluginMethod(name: "addWatcher", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeWatcher", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    /// 1 watcher = 1 CLLocationManager。callbackId で保存済み call を引く
    private final class Watcher {
        let callbackId: String
        let manager = CLLocationManager()
        init(_ callbackId: String) { self.callbackId = callbackId }
    }

    private var watchers: [Watcher] = []

    /// 降車し忘れ通知の識別子。移動を検知するたびに貼り直す
    private static let idleReminderId = "mobility.idle-reminder"
    /// これ以上動いたら「移動した」とみなす距離 [m]
    private static let idleMoveThresholdM: CLLocationDistance = 50
    /// 停止がこれだけ続いたら通知し、以降も同じ間隔で繰り返す [sec]
    private static let idleReminderInterval: TimeInterval = 30 * 60
    /// 最後に「移動した」と判定した位置
    private var lastMovedLocation: CLLocation?

    /// これより粗い測位は GNSS 由来ではないとみなして捨てる [m]。
    ///
    /// iOS は測位方式を選ばせてくれないが、Wi-Fi / 基地局由来の位置は
    /// horizontalAccuracy が数十〜数百 m になる。船舶・山岳の軌跡に、
    /// データベース由来の「まったく違う場所」が混ざるのは危険なので、
    /// 精度でふるいにかけて GNSS 相当だけを採用する。
    ///
    /// startMonitoringSignificantLocationChanges は基地局ベースだが、
    /// アプリを起こし直す用途で残している。そこで届く粗い位置はここで落ちる。
    private static let gnssMaxAccuracyM: CLLocationAccuracy = 50

    /// ロック画面 / Dynamic Island の常時表示 (iOS 16.2+)
    private var liveActivity: Any?
    /// Live Activity の更新間隔 [sec]。毎秒更新すると電池と ActivityKit の
    /// 予算を無駄に食うので間引く
    private static let activityUpdateInterval: TimeInterval = 30
    private var lastActivityUpdate: Date = .distantPast

    // MARK: - 公開 API

    @objc func addWatcher(_ call: CAPPluginCall) {
        call.keepAlive = true
        DispatchQueue.main.async {
            let watcher = Watcher(call.callbackId)
            let manager = watcher.manager
            manager.delegate = self
            // どちらも GNSS を使う精度。Wi-Fi / 基地局に落ちる
            // kCLLocationAccuracyHundredMeters 以下は使わない。
            // 給電中は測位を最優先、電池駆動時はわずかに緩めて消費を抑える。
            UIDevice.current.isBatteryMonitoringEnabled = true
            let charging = [.charging, .full].contains(UIDevice.current.batteryState)
            manager.desiredAccuracy =
                charging ? kCLLocationAccuracyBestForNavigation : kCLLocationAccuracyBest
            let filter = call.getDouble("distanceFilter") ?? 0
            // 0 のままだと以降の更新が来なくなる個体がある (本家 issue #88)
            manager.distanceFilter = filter > 0 ? filter : kCLDistanceFilterNone
            // 車載/船舶で長時間走るので、システムに一時停止させない
            manager.pausesLocationUpdatesAutomatically = false
            manager.activityType = .automotiveNavigation
            manager.allowsBackgroundLocationUpdates = true
            // バックグラウンドで位置を取っている間、ステータスバーに青い
            // インジケータを出す。利用者が「今送られているか」を判断できる
            manager.showsBackgroundLocationIndicator = true
            self.watchers.append(watcher)

            if call.getBool("requestPermissions") != false {
                let status = manager.authorizationStatus
                if [.notDetermined, .denied, .restricted].contains(status) {
                    // 許可が下りたら locationManagerDidChangeAuthorization で start する
                    manager.requestAlwaysAuthorization()
                    return
                }
                if status == .authorizedWhenInUse {
                    // アプリを閉じても送り続けるため Always へ昇格を促す
                    manager.requestAlwaysAuthorization()
                }
            }
            if #available(iOS 16.2, *) {
                self.startLiveActivity(vehicleName: self.vehicleName(from: call))
            }
            self.start(watcher)
        }
    }

    @objc func removeWatcher(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let callbackId = call.getString("id") else {
                call.reject("No callback ID")
                return
            }
            if let i = self.watchers.firstIndex(where: { $0.callbackId == callbackId }) {
                self.watchers[i].manager.stopUpdatingLocation()
                self.watchers[i].manager.stopMonitoringSignificantLocationChanges()
                self.watchers.remove(at: i)
            }
            if let saved = self.bridge?.savedCall(withID: callbackId) {
                self.bridge?.releaseCall(saved)
            }
            if self.watchers.isEmpty {
                if #available(iOS 16.2, *) { self.endLiveActivity() }
                self.cancelIdleReminder()
                self.lastMovedLocation = nil
                self.notify(
                    title: "位置の送信を停止しました",
                    body: "降車したため現在地の送信を終了しました。",
                )
            }
            call.resolve()
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.reject("Cannot open settings")
                return
            }
            UIApplication.shared.open(url) { ok in
                if ok { call.resolve() } else { call.reject("Failed to open settings") }
            }
        }
    }

    // MARK: - 内部処理

    private func start(_ watcher: Watcher) {
        watcher.manager.startUpdatingLocation()
        // 保険: iOS にアプリを終了されても、大きく移動すれば起こし直される。
        // 長時間の運行ではこれが無いと気づかないうちに記録が途切れる。
        watcher.manager.startMonitoringSignificantLocationChanges()

        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound]
        ) { granted, _ in
            guard granted else { return }
            self.notify(
                title: "位置の送信を開始しました",
                body: "乗車中はアプリを閉じていても現在地を送信します。降車すると停止します。",
            )
            self.scheduleIdleReminder()
        }
    }

    // MARK: - Live Activity
    //
    // 通知は一度流れると埋もれるが、Live Activity は乗車している間ずっと
    // ロック画面に残る。降車し忘れに気づける唯一の常時表示。

    /// backgroundMessage ("○○ の現在地を送信中") から車両名を取り出す。
    /// TS 側が notificationBody として渡してくる文字列で、専用の引数は無い。
    private func vehicleName(from call: CAPPluginCall) -> String {
        let msg = call.getString("backgroundMessage") ?? ""
        if let r = msg.range(of: " の現在地を送信中") {
            return String(msg[msg.startIndex..<r.lowerBound])
        }
        return msg.isEmpty ? "車両" : msg
    }

    @available(iOS 16.2, *)
    private func startLiveActivity(vehicleName name: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, liveActivity == nil else { return }
        do {
            liveActivity = try Activity.request(
                attributes: MobilityActivityAttributes(vehicleName: name),
                content: .init(
                    state: .init(lastSentAt: nil, pendingCount: 0, online: true),
                    staleDate: nil,
                ),
                pushType: nil,
            )
        } catch {
            print("[LiveActivity] 開始に失敗: \(error)")
        }
    }

    @available(iOS 16.2, *)
    private func updateLiveActivity() {
        guard let activity = liveActivity as? Activity<MobilityActivityAttributes> else { return }
        let now = Date()
        guard now.timeIntervalSince(lastActivityUpdate) >= Self.activityUpdateInterval else { return }
        lastActivityUpdate = now
        Task {
            await activity.update(
                .init(
                    state: .init(lastSentAt: now, pendingCount: 0, online: true),
                    staleDate: nil,
                )
            )
        }
    }

    @available(iOS 16.2, *)
    private func endLiveActivity() {
        guard let activity = liveActivity as? Activity<MobilityActivityAttributes> else { return }
        liveActivity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    // MARK: - 通知
    //
    // 青いステータスバーは画面を見ないと気づけないため、開始/停止と
    // 「降車し忘れ」を通知で伝える。実害が大きいのは取得そのものより、
    // 作業終了後に降車を忘れて送信が続くこと。

    private func notify(title: String, body: String, id: String = UUID().uuidString) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil)
        )
    }

    /// 停止が続いたときの「まだ乗車中です」通知を貼り直す。
    /// 移動を検知するたびに呼ぶので、走行中は発火しない。
    private func scheduleIdleReminder() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [Self.idleReminderId])
        let content = UNMutableNotificationContent()
        content.title = "まだ乗車中です"
        content.body = "しばらく動きがありません。作業が終わっていれば降車してください（位置の送信が止まります）。"
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: Self.idleReminderInterval,
            repeats: true,
        )
        center.add(
            UNNotificationRequest(
                identifier: Self.idleReminderId,
                content: content,
                trigger: trigger,
            )
        )
    }

    private func cancelIdleReminder() {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [Self.idleReminderId])
    }

    private func format(_ l: CLLocation) -> [String: Any] {
        return [
            "latitude": l.coordinate.latitude,
            "longitude": l.coordinate.longitude,
            "accuracy": l.horizontalAccuracy,
            "altitude": l.altitude,
            "altitudeAccuracy": l.verticalAccuracy,
            // speed / course は測れない時に負値。TS 側の型が nullable なので NSNull
            "speed": l.speed >= 0 ? l.speed : NSNull(),
            "bearing": l.course >= 0 ? l.course : NSNull(),
            "simulated": false,
            "time": l.timestamp.timeIntervalSince1970 * 1000,
        ]
    }
}

// MARK: - CLLocationManagerDelegate

extension MobilityLocationPlugin: CLLocationManagerDelegate {

    public func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last,
              let watcher = watchers.first(where: { $0.manager == m }),
              let call = bridge?.savedCall(withID: watcher.callbackId) else { return }
        // GNSS 相当の精度が出ているものだけ採用する。
        // 負値は測位失敗、粗い値は Wi-Fi / 基地局由来。
        guard last.horizontalAccuracy >= 0,
              last.horizontalAccuracy <= Self.gnssMaxAccuracyM else { return }
        // 十分に動いたら 「降車し忘れ」通知の タイマーを 貼り直す。
        // 走行中は 常に リセットされるので 通知は 出ない。
        if let prev = lastMovedLocation {
            if last.distance(from: prev) >= Self.idleMoveThresholdM {
                lastMovedLocation = last
                scheduleIdleReminder()
            }
        } else {
            lastMovedLocation = last
        }
        if #available(iOS 16.2, *) { updateLiveActivity() }
        call.resolve(format(last))
    }

    public func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        guard let watcher = watchers.first(where: { $0.manager == m }),
              let call = bridge?.savedCall(withID: watcher.callbackId) else { return }
        if let clErr = error as? CLError {
            // 一時的に測位できないだけ。復帰するのでエラー扱いにしない
            if clErr.code == .locationUnknown { return }
            if clErr.code == .denied {
                m.stopUpdatingLocation()
                call.reject("Permission denied.", "NOT_AUTHORIZED")
                return
            }
        }
        call.reject(error.localizedDescription, nil, error)
    }

    public func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        // 許可ダイアログ提示中の通知は無視する
        guard m.authorizationStatus != .notDetermined,
              let watcher = watchers.first(where: { $0.manager == m }) else { return }
        start(watcher)
    }
}
