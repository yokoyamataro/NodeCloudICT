import ActivityKit
import Foundation

/// Live Activity の型定義。
///
/// **App ターゲットと Widget 拡張の両方に所属させる必要がある**。
/// 拡張側はフォルダ同期 (PBXFileSystemSynchronizedRootGroup) で自動的に入るが、
/// App 側は project.pbxproj の Sources に手で登録している。
/// どちらか一方だけだと「型が見つからない」か「Activity が起動しない」になる。
struct MobilityActivityAttributes: ActivityAttributes {
    /// 走行中に変化する値
    public struct ContentState: Codable, Hashable {
        /// 最後にサーバへ送れた時刻 (nil = まだ 1 件も送れていない)
        var lastSentAt: Date?
        /// 未送信の件数 (圏外で溜まっている分)
        var pendingCount: Int
        /// 通信できているか
        var online: Bool
        /// 現在の速度 [km/h]。測れないときは nil
        var speedKmh: Double?
    }

    /// 開始時に決まり、以後変わらない値
    var vehicleName: String
}
