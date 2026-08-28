import Foundation
import UIKit
import Capacitor
import CoreLocation

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

    // MARK: - 公開 API

    @objc func addWatcher(_ call: CAPPluginCall) {
        call.keepAlive = true
        DispatchQueue.main.async {
            let watcher = Watcher(call.callbackId)
            let manager = watcher.manager
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
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
