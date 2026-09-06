// 線形物 (open channel) を 中心線 / 幅杭 / 線形点 / 中間点 の 4 種類に 分けて 描く。
//
// PC の 全体図 (OrthophotoPage) と スマホの 測設画面 (MobileStakingPage) の
// 両方から 使う。「全体図と 同じ 見た目」を 保つのが 目的なので、色や 太さを
// 変えるときは ここ 1 か所を 直す。座標変換は lib/openChannel/overlayRender.ts。
//
// 表示の 出し分けは subOn(key) を 呼び出し側から 渡してもらう。
// キーは 'ch:<channelId>' (親) と 'ch:<channelId>:center|stakes|vertices|stations'。

import { CircleMarker, Polyline as LeafletPolyline, Tooltip } from 'react-leaflet'
import type { ChannelOverlay } from '@/lib/openChannel/overlayRender'

export function OpenChannelOverlay({
  overlay,
  subOn,
}: {
  overlay: ChannelOverlay
  /** そのキーを 表示するか。呼び出し側の 「隠しているキー」集合で 判定する */
  subOn: (key: string) => boolean
}) {
  return (
    <>
      {overlay.lines
        .filter((l) => subOn(`ch:${l.channelId}`) && subOn(`ch:${l.channelId}:center`))
        .map((line) => (
          <LeafletPolyline
            key={`oc-line-${line.id}`}
            positions={line.positions}
            pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.9 }}
          >
            <Tooltip sticky direction="top" opacity={0.9}>
              {line.name}
            </Tooltip>
          </LeafletPolyline>
        ))}
      {overlay.stakes
        .filter((s) => subOn(`ch:${s.channelId}`) && subOn(`ch:${s.channelId}:stakes`))
        .map((s) => (
          <CircleMarker
            key={s.key}
            center={[s.lat, s.lng]}
            radius={4}
            pathOptions={{
              color: '#f59e0b',
              weight: 1.5,
              fillColor: '#fbbf24',
              fillOpacity: 0.9,
            }}
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.9}>
              <span className="text-[10px] font-mono">
                幅杭 offset={s.offset >= 0 ? '+' : ''}
                {s.offset.toFixed(2)}m{s.note ? ` (${s.note})` : ''}
              </span>
            </Tooltip>
          </CircleMarker>
        ))}
      {overlay.vertices
        .filter((v) => subOn(`ch:${v.channelId}`) && subOn(`ch:${v.channelId}:vertices`))
        .map((v) => {
          const color = v.label === 'BP' ? '#059669' : v.label === 'EP' ? '#dc2626' : '#7c3aed'
          // 座標 マーカー と 同位置 に 塗り丸 を 置くと 隠れる ので、
          // 塗り無し (ring) + 太めのストローク で 座標ドット を 囲む形 に する。
          return (
            <CircleMarker
              key={v.key}
              center={[v.lat, v.lng]}
              radius={9}
              pathOptions={{ color, weight: 2.5, fillOpacity: 0 }}
            >
              <Tooltip direction="top" offset={[0, -9]} opacity={0.9}>
                <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                  {v.channelName} — {v.label}
                </span>
              </Tooltip>
            </CircleMarker>
          )
        })}
      {overlay.stations
        .filter((s) => subOn(`ch:${s.channelId}`) && subOn(`ch:${s.channelId}:stations`))
        .map((s) => (
          <CircleMarker
            key={s.key}
            center={[s.lat, s.lng]}
            radius={3}
            pathOptions={{
              color: '#4f46e5',
              weight: 1,
              fillColor: '#818cf8',
              fillOpacity: 0.9,
            }}
          >
            {/* 常時表示 の SP ラベル (座標マーカー の 点名 表示 と 同じ スタイル)。
                point-label-tooltip クラス で 背景透過 + テキスト影 */}
            <Tooltip permanent direction="top" offset={[0, -4]} className="point-label-tooltip">
              <span
                style={{
                  color: '#4f46e5',
                  textShadow:
                    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                }}
              >
                {s.label}
              </span>
            </Tooltip>
          </CircleMarker>
        ))}
    </>
  )
}
