import ActivityKit
import WidgetKit
import SwiftUI

/// ロック画面 / Dynamic Island に「位置を送信中」を常時表示する。
///
/// 通知は一度流れると埋もれるが、Live Activity は乗車している間ずっと
/// ロック画面に残る。「今まだ送信されている」ことが画面を点けるだけで分かり、
/// 降車し忘れにも気づける。
struct MobilityLiveActivityLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MobilityActivityAttributes.self) { context in
            // ---- ロック画面 / バナー ----
            HStack(spacing: 12) {
                Image(systemName: "location.fill")
                    .font(.title3)
                    .foregroundStyle(context.state.online ? .green : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    // 行き先が一番知りたい情報なので車両名より前に出す。
                    // 未設定なら車両名で埋めず、未設定と分かるように出す
                    // (車両名だと「行き先が入っている」と誤読される)
                    Text(context.state.destinationName.map { "→ \($0)" } ?? "行き先未設定")
                        .font(.headline)
                        .lineLimit(1)
                        .foregroundStyle(
                            context.state.destinationName == nil ? .secondary : .primary,
                        )
                    Text(statusLine(context.state))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                // 走行距離を大きく出す。速度は運転中に見るものではないので載せない
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(String(format: "%.1f", context.state.distanceKm))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text("km").font(.caption2).foregroundStyle(.secondary)
                }
                if context.state.pendingCount > 0 {
                    VStack(spacing: 0) {
                        Text("\(context.state.pendingCount)")
                            .font(.headline)
                        Text("未送信").font(.caption2)
                    }
                    .foregroundStyle(.orange)
                }
            }
            .padding()
            .activitySystemActionForegroundColor(.primary)

        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(
                        context.state.destinationName ?? "行き先未設定",
                        systemImage: "location.fill",
                    )
                    .font(.caption)
                    .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(String(format: "%.1f km", context.state.distanceKm))
                        .font(.headline)
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.pendingCount > 0 {
                        Text("未送信 \(context.state.pendingCount)")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else {
                        Text("送信中").font(.caption).foregroundStyle(.green)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(statusLine(context.state))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: "location.fill")
                    .foregroundStyle(context.state.online ? .green : .orange)
            } compactTrailing: {
                // 幅が狭いので単位は小さめに
                HStack(spacing: 1) {
                    Text(String(format: "%.1f", context.state.distanceKm)).monospacedDigit()
                    Text("km").font(.system(size: 9))
                }
            } minimal: {
                Image(systemName: "location.fill")
                    .foregroundStyle(context.state.online ? .green : .orange)
            }
        }
    }

    private func statusLine(_ s: MobilityActivityAttributes.ContentState) -> String {
        if !s.online {
            return s.pendingCount > 0 ? "通信断 · 端末に保存中" : "通信断"
        }
        if s.pendingCount > 0 { return "再送中" }
        guard let t = s.lastSentAt else { return "位置を送信中" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return "位置を送信中 · 最終 \(f.string(from: t))"
    }
}
