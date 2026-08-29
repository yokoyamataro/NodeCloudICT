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
                    Text(context.attributes.vehicleName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(statusLine(context.state))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                // 速度はロック画面で一番見たい値なので大きく出す
                if let kmh = context.state.speedKmh {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text("\(Int(kmh.rounded()))")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .monospacedDigit()
                        Text("km/h").font(.caption2).foregroundStyle(.secondary)
                    }
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
                    Label(context.attributes.vehicleName, systemImage: "location.fill")
                        .font(.caption)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.center) {
                    if let kmh = context.state.speedKmh {
                        Text("\(Int(kmh.rounded())) km/h")
                            .font(.headline)
                            .monospacedDigit()
                    }
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
                // 単位が無いと何の数字か分からないので km/h まで出す。
                // Dynamic Island の compact は幅が狭いため小さめの字にする
                if let kmh = context.state.speedKmh {
                    HStack(spacing: 1) {
                        Text("\(Int(kmh.rounded()))").monospacedDigit()
                        Text("km/h").font(.system(size: 9))
                    }
                } else if context.state.pendingCount > 0 {
                    Text("\(context.state.pendingCount)")
                        .foregroundStyle(.orange)
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
