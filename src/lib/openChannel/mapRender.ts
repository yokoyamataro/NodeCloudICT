// 線形物 (open channel) を 地図に 出せる 形 (緯度経度) に 直す。
//
// 全体図 (UnifiedFieldMap) と スマホの 測設画面 (MobileStakingPage) が 同じ
// 見た目に なるよう、変換は ここ 1 か所に 置く。描画は OpenChannelLayer.tsx。

import {
  buildSegments,
  pointAtDistance,
  sampleAlignment,
  tangentAtDistance,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'
import type { OpenChannelRow } from '@/stores/openChannelStore'

/** 平面直角座標 ⇔ 緯度経度 の 変換器 (呼び出し側が 持っている ものを 渡す) */
export interface XYConverter {
  toLatLng: (x: number, y: number) => { lat: number; lng: number }
}

/** 座標テーブルの うち この レイヤが 要る 分だけ */
export interface OpenChannelCoordLike {
  id: string
  x: number
  y: number
}

export interface OpenChannelRender {
  channelId: string
  channelName: string
  line: [number, number][]
  alignmentPoints: { id: string; ll: [number, number]; label: 'BP' | 'IP' | 'EP' }[]
  widthStakes: { id: string; ll: [number, number]; offset: number; note: string | null }[]
}

/**
 * 線形物を 地図に 出せる 形 (緯度経度) に 直す。
 * alignmentPoints は 座標 ID 参照 なので coordinates で 解決 する。
 * kind は 位置 (先頭=BP / 末尾=EP / それ以外=IP) で 自動判定。
 */
export function buildOpenChannelRenders(
  openChannels: OpenChannelRow[],
  coordinates: OpenChannelCoordLike[],
  converter: XYConverter,
): OpenChannelRender[] {
  const out: OpenChannelRender[] = []
  for (const ch of openChannels) {
    // 頂点 (BP/IP/EP) を 座標 テーブル から 解決。 未解決 は スキップ。
    const vertices: AlignmentVertex[] = []
    const alignmentMarkers: OpenChannelRender['alignmentPoints'] = []
    const total = ch.alignmentPoints.length
    for (let i = 0; i < total; i++) {
      const p = ch.alignmentPoints[i]
      const c = coordinates.find((cc) => cc.id === p.coordId)
      if (!c) continue
      const kind: 'BP' | 'IP' | 'EP' =
        total <= 1 || i === 0 ? 'BP' : i === total - 1 ? 'EP' : 'IP'
      vertices.push({
        x: c.x,
        y: c.y,
        kind: kind.toLowerCase() as AlignmentVertex['kind'],
        radius: p.radius,
        spiralAIn: p.spiralAIn,
        spiralAOut: p.spiralAOut,
      })
      try {
        const ll = converter.toLatLng(c.x, c.y)
        if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
          alignmentMarkers.push({
            id: `${ch.id}-v-${i}`,
            ll: [ll.lat, ll.lng],
            label: kind,
          })
        }
      } catch {
        /* skip */
      }
    }
    if (vertices.length < 2) {
      // 頂点 1 個 のみでも BP マーカーだ け 出しておく
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        line: [],
        alignmentPoints: alignmentMarkers,
        widthStakes: [],
      })
      continue
    }
    // 中心線 (サンプリング + LatLng 化)
    const sampled = sampleAlignment(vertices, 32)
    const line: [number, number][] = []
    for (const p of sampled) {
      try {
        const ll = converter.toLatLng(p.x, p.y)
        if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
          line.push([ll.lat, ll.lng])
        }
      } catch {
        /* skip */
      }
    }
    // 幅杭 (中心線 に 垂直、 右手 = CCW 90°、 sideOrientation='reverse' で 反転)
    const segments = buildSegments(vertices)
    const sign = ch.sideOrientation === 'reverse' ? -1 : 1
    const widthStakes: OpenChannelRender['widthStakes'] = []
    for (const s of ch.widthStakes) {
      const c = pointAtDistance(segments, s.distance)
      const t = tangentAtDistance(segments, s.distance)
      if (!c || !t) continue
      const px = c.x - t.y * sign * s.offset
      const py = c.y + t.x * sign * s.offset
      try {
        const ll = converter.toLatLng(px, py)
        if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) continue
        widthStakes.push({
          id: s.id,
          ll: [ll.lat, ll.lng],
          offset: s.offset,
          note: s.note ?? null,
        })
      } catch {
        /* skip */
      }
    }
    out.push({
      channelId: ch.id,
      channelName: ch.name,
      line,
      alignmentPoints: alignmentMarkers,
      widthStakes,
    })
  }
  return out
}
