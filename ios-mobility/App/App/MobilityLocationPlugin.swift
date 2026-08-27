import Foundation
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
/// 返す位置の形も本家に合わせる:
///   latitude / longitude / accuracy / altitude / altitudeAccuracy
///   / simulated / speed / bearing / time
///
/// エラーコードは TS 側が大文字で判定しているため 'NOT_AUTHORIZED' 等を返す。
@objc(MobilityLocationPlugin)
public class MobilityLocationPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "MobilityLocationPlugin"
    // ここが TS の registerPlugin 名と一致している必要がある
    public let jsName = "BackgroundGeolocation"
    public let pluginMethods: [CAPPluginMethod] = [
        // addWatcher は 位置が 更新される たびに 呼び返すので Callback 型。
        // call.keepAlive = true で 保持し、resolve を 繰り返す。
        CAPPluginMethod(name: "addWatcher", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeWatcher", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private let manager = CLLocationManager()
    /// watcher id → 保持している call。複数 watcher に 同じ位置を 配る
    private var watchers: [String: CAPPluginCall] = [:]
    /// 権限待ちの間に届いた watcher。許可が下りたら開始する
    private var pendingAuthorization = false

    public override func load() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        // バックグラウンドでも 位置を 受け取る。Xcode の
        // Signing & Capabilities → Background Modes → Location updates が 必須。
        manager.allowsBackgroundLocationUpdates = true
        // 車載/船舶で 長時間 走るので、システムに 一時停止させない。
        // (true だと 停車中に iOS が 更新を 止め、再開の 保証が 無い)
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .automotiveNavigation
    }

    // MARK: - 公開 API

    @objc func addWatcher(_ call: CAPPluginCall) {
        call.keepAlive = true
        let id = UUID().uuidString
        watchers[id] = call

        // distanceFilter: 指定が 無い / 0 以下なら 全更新を 受ける
        let filter = call.getDouble("distanceFilter") ?? 0
        manager.distanceFilter = filter > 0 ? filter : kCLDistanceFilterNone

        let requestPermissions = call.getBool("requestPermissions") ?? true
        // インスタンス側の authorizationStatus (iOS 14+)。型メソッドは deprecated。
        let status = manager.authorizationStatus

        switch status {
        case .notDetermined:
            if requestPermissions {
                pendingAuthorization = true
                // Always を 要求する。アプリを 閉じても 送り続けるため。
                // (iOS は まず WhenInUse を 出し、後から Always への 昇格を 促す)
                manager.requestAlwaysAuthorization()
            } else {
                reject(call, "NOT_AUTHORIZED", "位置情報の使用が許可されていません")
            }
        case .denied, .restricted:
            reject(call, "NOT_AUTHORIZED", "位置情報の使用が許可されていません")
        case .authorizedAlways, .authorizedWhenInUse:
            startUpdates()
        @unknown default:
            startUpdates()
        }

        // 呼び出し側は addWatcher の 戻り値 (id) で removeWatcher する
        call.resolve(["callbackId": id])
    }

    @objc func removeWatcher(_ call: CAPPluginCall) {
        if let id = call.getString("id") {
            if let held = watchers.removeValue(forKey: id) {
                held.keepAlive = false
                bridge?.releaseCall(held)
            }
        }
        if watchers.isEmpty {
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
        }
        call.resolve()
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("設定画面を開けませんでした")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        call.resolve()
    }

    // MARK: - 内部処理

    private func startUpdates() {
        manager.startUpdatingLocation()
        // 保険: iOS に アプリを 終了されても、大きく 移動すれば 起こし直される。
        // 長時間の 運行では これが 無いと 気づかないうちに 記録が 途切れる。
        manager.startMonitoringSignificantLocationChanges()
    }

    private func reject(_ call: CAPPluginCall, _ code: String, _ message: String) {
        // TS 側は callback の 第 2 引数で error を 受ける形なので、
        // resolve で error を 積んで 返す (call は 生かしたまま)
        call.resolve(["error": ["code": code, "message": message]])
    }

    private func emit(_ location: CLLocation) {
        let data: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.altitude,
            "altitudeAccuracy": location.verticalAccuracy,
            // speed / course は 測れない時 負値。TS 側の 型が nullable なので
            // その場合は NSNull を 返す
            "speed": location.speed >= 0 ? location.speed : NSNull(),
            "bearing": location.course >= 0 ? location.course : NSNull(),
            "simulated": false,
            "time": location.timestamp.timeIntervalSince1970 * 1000,
        ]
        for call in watchers.values {
            call.resolve(data)
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension MobilityLocationPlugin: CLLocationManagerDelegate {

    public func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        emit(last)
    }

    public func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        let ns = error as NSError
        // kCLErrorLocationUnknown は 一時的に 測位できないだけ。
        // 復帰するので エラー扱いに しない。
        if ns.domain == kCLErrorDomain && ns.code == CLError.locationUnknown.rawValue { return }
        let code = ns.code == CLError.denied.rawValue ? "NOT_AUTHORIZED" : "LOCATION_ERROR"
        for call in watchers.values {
            call.resolve(["error": ["code": code, "message": error.localizedDescription]])
        }
    }

    public func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        guard pendingAuthorization else { return }
        switch m.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            pendingAuthorization = false
            startUpdates()
        case .denied, .restricted:
            pendingAuthorization = false
            for call in watchers.values {
                call.resolve([
                    "error": ["code": "NOT_AUTHORIZED", "message": "位置情報の使用が許可されていません"],
                ])
            }
        default:
            break
        }
    }
}
