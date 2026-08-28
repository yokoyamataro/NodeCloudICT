import WidgetKit
import SwiftUI

// Live Activity のみ。Xcode のテンプレートが同時に作る
// ホーム画面ウィジェットと Control Center ウィジェットは使わないので削除した
// (Control は iOS 18 以降が必要で、拡張の対応 OS を上げてしまう)。
@main
struct MobilityLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        MobilityLiveActivityLiveActivity()
    }
}
