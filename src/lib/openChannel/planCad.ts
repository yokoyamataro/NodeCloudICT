import type { DxfShape } from '@/lib/dxfRender'

/**
 * 平面図 CAD を 地図 に 重ねる ため の 位置合わせ。
 *
 * 図面 の 2 点 と、 その 点 の 実 座標 を 組 に して 渡す と、
 * 回転 + 一様 倍率 + 平行移動 (相似変換) が 決まる。 3 点 以上 の 最小二乗 は
 * 使わ ない。 現場 で 拾う の は 基準 に なる 2 点 だけ で 足りる。
 *
 * 軸 の 向き:
 *   DXF は (x = 東, y = 北) の 向き で 描かれて いる の が 普通。
 *   こちら の 実 座標 は 測量 の 慣習 で (x = 北, y = 東)。
 *   そこ で 計算 は 「東, 北」 の 並び に 揃えて から 行い、 最後 に 戻す。
 */

/** 図面 の 点 と、 その 点 の 実 座標 (x = 北, y = 東) */
export interface PlanCadAnchor {
  /** 図面 の 座標 */
  dx: number
  dy: number
  /** 実 座標 */
  x: number
  y: number
}

/** 路線 に 貼り付けた 平面図 CAD */
export interface PlanCadConfig {
  /** 使う 図面 (channel.dxfCrossSections の id) */
  dxfId: string
  p1: PlanCadAnchor
  p2: PlanCadAnchor
  /** 地図 に 出す か */
  visible?: boolean
  /** 濃さ (0-1)。 既定 0.7 */
  opacity?: number
  /** 出さ ない 画層 */
  hiddenLayers?: string[]
}

/** 図面 → 実 座標 の 相似変換 */
export interface PlanCadTransform {
  /** 倍率 (実 / 図面) */
  scale: number
  /** 回転 [rad]。 東 を 基準 に 反時計回り */
  rotation: number
  /** 図面 の 基準点 */
  from: { dx: number; dy: number }
  /** 実 座標 の 基準点 (x = 北, y = 東) */
  to: { x: number; y: number }
}

/**
 * 2 点 の 組 から 変換 を 決める。
 * 図面 上 の 2 点 が 同じ 位置、 または 実 座標 の 2 点 が 同じ 位置 なら
 * 倍率 が 決まら ない ので null。
 */
export function solvePlanCadTransform(
  p1: PlanCadAnchor,
  p2: PlanCadAnchor,
): PlanCadTransform | null {
  // 図面 の 向き (東, 北)
  const vdx = p2.dx - p1.dx
  const vdy = p2.dy - p1.dy
  // 実 座標 も (東, 北) に 並べ 替える
  const vwx = p2.y - p1.y
  const vwy = p2.x - p1.x
  const ld = Math.hypot(vdx, vdy)
  const lw = Math.hypot(vwx, vwy)
  if (ld < 1e-9 || lw < 1e-9) return null
  return {
    scale: lw / ld,
    rotation: Math.atan2(vwy, vwx) - Math.atan2(vdy, vdx),
    from: { dx: p1.dx, dy: p1.dy },
    to: { x: p1.x, y: p1.y },
  }
}

/** 図面 の 点 → 実 座標 (x = 北, y = 東) */
export function planCadToWorld(
  t: PlanCadTransform,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const ux = dx - t.from.dx
  const uy = dy - t.from.dy
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  // (東, 北) で 回して から 倍率
  const east = (ux * c - uy * s) * t.scale
  const north = (ux * s + uy * c) * t.scale
  return { x: t.to.x + north, y: t.to.y + east }
}

/** 実 座標 → 図面 の 点 (逆変換) */
export function worldToPlanCad(
  t: PlanCadTransform,
  x: number,
  y: number,
): { dx: number; dy: number } {
  const east = (y - t.to.y) / t.scale
  const north = (x - t.to.x) / t.scale
  const c = Math.cos(-t.rotation)
  const s = Math.sin(-t.rotation)
  return {
    dx: t.from.dx + (east * c - north * s),
    dy: t.from.dy + (east * s + north * c),
  }
}

/** 円 / 円弧 を 折れ線 に する ときの 刻み [度] */
const ARC_STEP_DEG = 6

/**
 * 図形 を 折れ線 の 並び に 直す。
 * 地図 に は 線 と して 出す ので、 円 と 円弧 は 適当 な 刻み で 折る。
 * 文字 は 扱わ ない (地図 に 出す と 読め ない ほど 小さく なる)。
 */
export function planCadShapeToPolylines(shape: DxfShape): { x: number; y: number }[][] {
  switch (shape.kind) {
    case 'line':
      return [
        [
          { x: shape.x1, y: shape.y1 },
          { x: shape.x2, y: shape.y2 },
        ],
      ]
    case 'polyline': {
      if (shape.pts.length < 2) return []
      const pts = shape.pts.map((p) => ({ x: p.x, y: p.y }))
      if (shape.closed) pts.push({ ...pts[0] })
      return [pts]
    }
    case 'circle': {
      const out: { x: number; y: number }[] = []
      for (let a = 0; a <= 360; a += ARC_STEP_DEG) {
        const r = (a * Math.PI) / 180
        out.push({ x: shape.cx + shape.r * Math.cos(r), y: shape.cy + shape.r * Math.sin(r) })
      }
      return [out]
    }
    case 'arc': {
      let sweep = shape.endDeg - shape.startDeg
      while (sweep < 0) sweep += 360
      if (sweep < 1e-9) sweep = 360
      const steps = Math.max(2, Math.ceil(sweep / ARC_STEP_DEG))
      const out: { x: number; y: number }[] = []
      for (let i = 0; i <= steps; i++) {
        const a = ((shape.startDeg + (sweep * i) / steps) * Math.PI) / 180
        out.push({ x: shape.cx + shape.r * Math.cos(a), y: shape.cy + shape.r * Math.sin(a) })
      }
      return [out]
    }
    default:
      return []
  }
}
