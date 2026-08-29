// ペイント (map_drawings) を DXF に書き出す。
//
// 作図・計測ツールをペイントへ統合したので、DXF 出力もペイントのデータから作る。
// CAD の慣例に合わせて X=東 / Y=北 で書き出す (平面直角座標は X=北 / Y=東 なので入れ替える)。
// レイヤは種別ごとに分ける。CAD 側で線と面を分けて扱えた方が実務で使いやすい。

import type { CoordinateConverter } from '@/lib/coordinates'
import type { DxfEntity } from '@/lib/dxf'
import type { MapDrawingStroke } from '@/stores/mapDrawingStore'

const LAYER: Record<MapDrawingStroke['kind'], string> = {
  stroke: 'PAINT_LINE',
  polygon: 'PAINT_AREA',
  circle: 'PAINT_CIRCLE',
  arc: 'PAINT_ARC',
  text: 'PAINT_TEXT',
}

/** 文字の高さ [m]。CAD で開いた時に読める程度の既定値 */
const TEXT_HEIGHT_M = 1.0

export function buildMapDrawingDxfEntities(
  items: readonly MapDrawingStroke[],
  converter: CoordinateConverter,
): DxfEntity[] {
  // 平面 (X=北, Y=東) → DXF (X=東, Y=北)
  const xy = (lat: number, lng: number) => {
    const p = converter.toXY(lat, lng)
    return { x: p.y, y: p.x }
  }

  const entities: DxfEntity[] = []

  for (const it of items) {
    const layer = LAYER[it.kind]
    const pts = it.points.map((p) => xy(p.lat, p.lng))

    if (it.kind === 'text') {
      if (pts.length < 1 || !it.text) continue
      entities.push({
        type: 'TEXT',
        x: pts[0].x,
        y: pts[0].y,
        text: it.text,
        height: TEXT_HEIGHT_M,
        layer,
      })
      continue
    }

    if (it.kind === 'circle') {
      if (pts.length < 2) continue
      const [c, edge] = pts
      const r = Math.hypot(edge.x - c.x, edge.y - c.y)
      if (r <= 0) continue
      entities.push({ type: 'CIRCLE', cx: c.x, cy: c.y, r, layer })
      continue
    }

    if (it.kind === 'arc') {
      if (pts.length < 3) continue
      const arc = circumArc(pts[0], pts[1], pts[2])
      if (!arc) {
        // 3 点が一直線 → 円弧にならないので線分として出す
        entities.push({ type: 'LINE', x1: pts[0].x, y1: pts[0].y, x2: pts[2].x, y2: pts[2].y, layer })
        continue
      }
      entities.push({ type: 'ARC', ...arc, layer })
      continue
    }

    // stroke / polygon: 連続する線分に分解する
    if (pts.length < 2) continue
    for (let i = 0; i < pts.length - 1; i += 1) {
      entities.push({
        type: 'LINE',
        x1: pts[i].x,
        y1: pts[i].y,
        x2: pts[i + 1].x,
        y2: pts[i + 1].y,
        layer,
      })
    }
    if (it.kind === 'polygon' && pts.length >= 3) {
      const a = pts[pts.length - 1]
      const b = pts[0]
      entities.push({ type: 'LINE', x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer })
    }
  }

  return entities
}

interface XY {
  x: number
  y: number
}

/**
 * 3 点を通る円弧を DXF の ARC (中心 / 半径 / 開始角 / 終了角) に直す。
 * DXF の ARC は常に反時計回りなので、通過点が弧に乗るよう向きを決める。
 * 3 点が一直線なら null。
 */
function circumArc(
  a: XY,
  b: XY,
  c: XY,
): { cx: number; cy: number; r: number; startAngleDeg: number; endAngleDeg: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  const r = Math.hypot(a.x - cx, a.y - cy)

  const ang = (p: XY) => Math.atan2(p.y - cy, p.x - cx)
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a0 = ang(a)
  const am = ang(b)
  const a1 = ang(c)

  // a → c を反時計回りに進んだとき、途中に b が入るかどうか。
  // 入らないなら始点と終点を入れ替える (DXF の ARC は反時計回り固定のため)
  const ccwContains = norm(am - a0) < norm(a1 - a0)
  const [s, e] = ccwContains ? [a0, a1] : [a1, a0]

  const deg = (t: number) => (norm(t) * 180) / Math.PI
  return { cx, cy, r, startAngleDeg: deg(s), endAngleDeg: deg(e) }
}
