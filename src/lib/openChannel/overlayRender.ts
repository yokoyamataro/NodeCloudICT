// 線形物 (open channel) を 「中心線 / 幅杭 / 線形点 (BP・IP・EP) / 中間点」の
// 4 種類に 分けて 地図に 出せる 形 (緯度経度) に 直す。
//
// PC の 全体図 と スマホの 測設画面 で 同じ 見た目・同じ 出し分けに なるよう、
// 変換は ここ 1 か所に 置く。描画は components/map/OpenChannelOverlay.tsx。
//
// 4 種類に 分かれていない 簡易版 (1 トグル) は mapRender.ts / OpenChannelLayer.tsx。

import {
  buildSegments,
  pointAtDistance,
  sampleAlignment,
  tangentAtDistance,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'
import type { OpenChannelRow } from '@/stores/openChannelStore'

/** 平面直角座標 ⇔ 緯度経度 の 変換器 */
export interface XYToLatLng {
  toLatLng: (x: number, y: number) => { lat: number; lng: number }
}

/** 座標テーブルの うち この レイヤが 要る 分だけ */
export interface ChannelCoordLike {
  id: string
  x: number
  y: number
}

export interface ChannelLine {
  id: string
  channelId: string
  positions: [number, number][]
  name: string
}
export interface ChannelStake {
  key: string
  channelId: string
  lat: number
  lng: number
  offset: number
  note: string | null
}
export interface ChannelVertex {
  key: string
  channelId: string
  lat: number
  lng: number
  label: 'BP' | 'IP' | 'EP'
  channelName: string
}
export interface ChannelStation {
  key: string
  /** StationRow の id (測設ターゲットの 参照先に 使う) */
  stationId: string
  channelId: string
  channelName: string
  lat: number
  lng: number
  /** 平面直角座標。測設の 誘導は こちらで 計算する */
  x: number
  y: number
  /** BP からの 追加距離 [m]。断面の 向きを 出すのに 使う */
  distance: number
  /** 中心線上の 高さ [m]。計画高、無ければ 現況高、どちらも 無ければ null */
  z: number | null
  label: string
}

export interface ChannelOverlay {
  lines: ChannelLine[]
  stakes: ChannelStake[]
  vertices: ChannelVertex[]
  stations: ChannelStation[]
}

export const EMPTY_CHANNEL_OVERLAY: ChannelOverlay = {
  lines: [],
  stakes: [],
  vertices: [],
  stations: [],
}

/**
 * 線形物を 4 種類に 分けて 緯度経度に 直す。
 * alignmentPoints は 座標 ID 参照 なので coordinates で 解決 する。
 * 線形点の 種類は 位置 (先頭=BP / 末尾=EP / それ以外=IP) で 自動判定。
 */
export function buildChannelOverlay(
  openChannels: OpenChannelRow[],
  coordinates: ChannelCoordLike[],
  conv: XYToLatLng | null,
): ChannelOverlay {
  if (!conv) return EMPTY_CHANNEL_OVERLAY
  const lines: ChannelLine[] = []
  const stakes: ChannelStake[] = []
  const vertices: ChannelVertex[] = []
  const stations: ChannelStation[] = []
  for (const ch of openChannels) {
    const verts: AlignmentVertex[] = []
    const total = ch.alignmentPoints.length
    for (let i = 0; i < total; i++) {
      const p = ch.alignmentPoints[i]
      const c = coordinates.find((cc) => cc.id === p.coordId)
      if (!c) continue
      const label: 'BP' | 'IP' | 'EP' =
        total <= 1 || i === 0 ? 'BP' : i === total - 1 ? 'EP' : 'IP'
      verts.push({
        x: c.x,
        y: c.y,
        kind: label.toLowerCase() as AlignmentVertex['kind'],
        radius: p.radius,
        spiralAIn: p.spiralAIn,
        spiralAOut: p.spiralAOut,
      })
      try {
        const { lat, lng } = conv.toLatLng(c.x, c.y)
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          vertices.push({
            key: `oc-v-${ch.id}-${i}`,
            channelId: ch.id,
            lat,
            lng,
            label,
            channelName: ch.name,
          })
        }
      } catch {
        /* skip */
      }
    }
    if (verts.length < 2) continue
    const sampled = sampleAlignment(verts, 32)
    const positions: [number, number][] = []
    for (const s of sampled) {
      try {
        const { lat, lng } = conv.toLatLng(s.x, s.y)
        if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push([lat, lng])
      } catch {
        /* skip */
      }
    }
    if (positions.length >= 2) {
      lines.push({ id: ch.id, channelId: ch.id, positions, name: ch.name })
    }
    const segments = buildSegments(verts)
    const sign = ch.sideOrientation === 'reverse' ? -1 : 1
    for (const w of ch.widthStakes) {
      const cp = pointAtDistance(segments, w.distance)
      const t = tangentAtDistance(segments, w.distance)
      if (!cp || !t) continue
      const px = cp.x - t.y * sign * w.offset
      const py = cp.y + t.x * sign * w.offset
      try {
        const { lat, lng } = conv.toLatLng(px, py)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        stakes.push({
          key: `oc-w-${w.id}`,
          channelId: ch.id,
          lat,
          lng,
          offset: w.offset,
          note: w.note ?? null,
        })
      } catch {
        /* skip */
      }
    }
    // 中間点 (stations): 中心線 上 の 距離 で 定義 → 世界座標 → LatLng
    for (const st of ch.stations ?? []) {
      const cp = pointAtDistance(segments, st.distance)
      if (!cp) continue
      try {
        const { lat, lng } = conv.toLatLng(cp.x, cp.y)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        stations.push({
          key: `oc-s-${st.id}`,
          stationId: st.id,
          channelId: ch.id,
          channelName: ch.name,
          lat,
          lng,
          x: cp.x,
          y: cp.y,
          distance: st.distance,
          z: st.plannedCenterHeight ?? st.currentGroundHeight ?? null,
          label: st.label,
        })
      } catch {
        /* skip */
      }
    }
  }
  return { lines, stakes, vertices, stations }
}
