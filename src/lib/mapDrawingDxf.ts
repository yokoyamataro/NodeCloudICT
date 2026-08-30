// ペイント (map_drawings) を DXF に書き出す。
//
// 作図・計測ツールをペイントへ統合したので、DXF 出力もペイントのデータから作る。
// CAD の慣例に合わせて X=東 / Y=北 で書き出す (平面直角座標は X=北 / Y=東 なので入れ替える)。
// レイヤは 図形に付いた レイヤ名を使う。未指定 ('0') なら 種別ごとの既定名にする。
// CAD 側で 線と面を 分けて扱えた方が 実務で使いやすい。

import type { CoordinateConverter } from '@/lib/coordinates'
import type { DxfEntity } from '@/lib/dxf'
import type { MapDrawingStroke } from '@/stores/mapDrawingStore'

/** レイヤ名が未指定 ('0' のまま) のときに使う、種別ごとの既定レイヤ */
const DEFAULT_LAYER: Record<MapDrawingStroke['kind'], string> = {
  stroke: 'PAINT_LINE',
  polygon: 'PAINT_AREA',
  circle: 'PAINT_CIRCLE',
  arc: 'PAINT_ARC',
  text: 'PAINT_TEXT',
  point: 'PAINT_POINT',
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
    const named = (it.layer ?? '').trim()
    const layer = named && named !== '0' ? named : DEFAULT_LAYER[it.kind]
    const pts = it.points.map((p) => xy(p.lat, p.lng))

    if (it.kind === 'point') {
      if (pts.length < 1) continue
      entities.push({ type: 'POINT', x: pts[0].x, y: pts[0].y, layer })
      continue
    }

    if (it.kind === 'text') {
      if (pts.length < 1 || !it.text) continue
      entities.push({
        type: 'TEXT',
        x: pts[0].x,
        y: pts[0].y,
        text: it.text,
        // 画面上の px を そのまま m にはできないので、既定値からの 比率で 換算する
        height: TEXT_HEIGHT_M * ((it.font_size ?? 14) / 14),
        rotationDeg: it.rotation_deg || undefined,
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
        pushArrows(entities, it.arrow, pts[0], pts[2], pts[2], pts[0], layer)
        continue
      }
      entities.push({ type: 'ARC', ...arc, layer })
      // 矢印の向きは 端点での 接線 (中心 → 端点 に直交する向き)
      const tan = (p: XY, sign: number): XY => ({
        x: p.x + sign * -(p.y - arc.cy),
        y: p.y + sign * (p.x - arc.cx),
      })
      // 弧が 進む向きを 通過点で 判定する
      const forward = tangentSign(arc, pts[0], pts[1])
      pushArrows(entities, it.arrow, tan(pts[0], forward), pts[0], tan(pts[2], -forward), pts[2], layer)
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

    // 端部の矢印
    if (it.kind === 'stroke') {
      pushArrows(entities, it.arrow, pts[1], pts[0], pts[pts.length - 2], pts[pts.length - 1], layer)
    }
  }

  return entities
}

interface XY {
  x: number
  y: number
}

/** 矢印の羽根の長さ [m]。CAD で開いた時に見える程度の既定値 */
const ARROW_LEN_M = 1.0
/** 羽根の開き [度] */
const ARROW_SPREAD_DEG = 20

/**
 * 端部の矢印を 羽根の線として 足す。DXF に 矢印そのものは 無いため。
 * start 側は (startPrev → startTip)、end 側は (endPrev → endTip) の向きで出す。
 */
function pushArrows(
  entities: DxfEntity[],
  arrow: string | null | undefined,
  startPrev: XY | undefined,
  startTip: XY | undefined,
  endPrev: XY | undefined,
  endTip: XY | undefined,
  layer: string,
): void {
  if (!arrow || arrow === 'none') return
  const jobs: Array<[XY | undefined, XY | undefined]> = []
  if (arrow === 'start' || arrow === 'both') jobs.push([startPrev, startTip])
  if (arrow === 'end' || arrow === 'both') jobs.push([endPrev, endTip])
  for (const [prev, tip] of jobs) {
    if (!prev || !tip) continue
    for (const w of arrowWings(prev, tip)) {
      entities.push({ type: 'LINE', x1: tip.x, y1: tip.y, x2: w.x, y2: w.y, layer })
    }
  }
}

/** 円弧が 始点から どちら回りに 進むか (+1 = 反時計回り) */
function tangentSign(
  arc: { cx: number; cy: number },
  start: XY,
  mid: XY,
): number {
  // 中心→始点 と 中心→通過点 の 外積の符号が 進行方向
  const a = { x: start.x - arc.cx, y: start.y - arc.cy }
  const b = { x: mid.x - arc.cx, y: mid.y - arc.cy }
  return a.x * b.y - a.y * b.x >= 0 ? 1 : -1
}

/** prev → tip の向きに対する、矢印の羽根 2 本の 端点 */
function arrowWings(prev: XY, tip: XY): [XY, XY] {
  const base = Math.atan2(prev.y - tip.y, prev.x - tip.x)
  const spread = (ARROW_SPREAD_DEG * Math.PI) / 180
  const wing = (a: number): XY => ({
    x: tip.x + ARROW_LEN_M * Math.cos(a),
    y: tip.y + ARROW_LEN_M * Math.sin(a),
  })
  return [wing(base - spread), wing(base + spread)]
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
