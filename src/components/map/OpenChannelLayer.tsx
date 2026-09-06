// 線形物 (open channel) の 中心線 + 幅杭 + 線形点 (BP/IP/EP) を 地図に 描く。
//
// 全体図 (UnifiedFieldMap) と スマホの 測設画面 (MobileStakingPage) の 両方から
// 使う。「全体図と 同じ 見た目」を 保つのが 目的なので、色や 太さを 変えるときは
// ここ 1 か所を 直す。座標変換は lib/openChannel/mapRender.ts。

import type React from 'react'
import { useMemo } from 'react'
import { CircleMarker, Marker, Polyline, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import {
  buildOpenChannelRenders,
  type OpenChannelCoordLike,
  type OpenChannelRender,
  type XYConverter,
} from '@/lib/openChannel/mapRender'
import type { OpenChannelRow } from '@/stores/openChannelStore'

function createChannelPointIcon(kind: 'BP' | 'IP' | 'EP'): L.DivIcon {
  const color = kind === 'BP' ? '#059669' : kind === 'EP' ? '#dc2626' : '#7c3aed'
  return L.divIcon({
    className: 'unified-map-oc-vertex',
    html: `<div style="display:flex;align-items:center;gap:3px;transform:translate(-9px,-9px)">
        <div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>
        <div style="color:${color};font-weight:700;font-size:11px;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;line-height:1">${kind}</div>
      </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

/** 中心線 / 幅杭 / 線形点 を 描く。MapContainer の 中で 使う */
export function OpenChannelLayer({ renders }: { renders: OpenChannelRender[] }) {
  return (
    <>
      {renders.flatMap((ch) => {
        const nodes: React.ReactNode[] = []
        if (ch.line.length >= 2) {
          nodes.push(
            <Polyline
              key={`oc-line-${ch.channelId}`}
              positions={ch.line}
              pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.9 }}
            >
              <Tooltip sticky direction="top">
                {ch.channelName}
              </Tooltip>
            </Polyline>,
          )
        }
        for (const s of ch.widthStakes) {
          nodes.push(
            <CircleMarker
              key={`oc-stake-${s.id}`}
              center={s.ll}
              radius={4}
              pathOptions={{
                color: '#f59e0b',
                weight: 1.5,
                fillColor: '#fbbf24',
                fillOpacity: 0.9,
              }}
            >
              <Tooltip direction="top">
                幅杭 offset={s.offset >= 0 ? '+' : ''}
                {s.offset.toFixed(2)}m{s.note ? ` (${s.note})` : ''}
              </Tooltip>
            </CircleMarker>,
          )
        }
        for (const v of ch.alignmentPoints) {
          nodes.push(
            <Marker
              key={`oc-v-${v.id}`}
              position={v.ll}
              icon={createChannelPointIcon(v.label)}
              interactive={true}
              zIndexOffset={500}
            >
              <Tooltip direction="top">
                {ch.channelName} — {v.label}
              </Tooltip>
            </Marker>,
          )
        }
        return nodes
      })}
    </>
  )
}

/** 変換 + 描画 を まとめた 版。呼び出し側は これ 1 つで 済む */
export function OpenChannelLayerFromData({
  openChannels,
  coordinates,
  converter,
}: {
  openChannels: OpenChannelRow[]
  coordinates: OpenChannelCoordLike[]
  converter: XYConverter
}) {
  const renders = useMemo(
    () => buildOpenChannelRenders(openChannels, coordinates, converter),
    [openChannels, coordinates, converter],
  )
  return <OpenChannelLayer renders={renders} />
}
