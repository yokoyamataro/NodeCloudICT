// Alignment セグメントを、描画用の点列（実座標 x,y の配列）にサンプリングするユーティリティ。

import type { AlignmentSegment } from './types'

export interface Point2D {
  x: number // 北
  y: number // 東
}

const DEFAULT_CURVE_STEP = 1.0 // 円弧を何 m ごとに分割するか

// セグメントを点列化
export function sampleSegment(seg: AlignmentSegment, step: number = DEFAULT_CURVE_STEP): Point2D[] {
  if (seg.type === 'line') {
    return [
      { x: seg.startX, y: seg.startY },
      { x: seg.endX, y: seg.endY },
    ]
  }

  if (seg.type === 'curve' && seg.centerX != null && seg.centerY != null && seg.radius) {
    const cx = seg.centerX
    const cy = seg.centerY
    const r = Math.abs(seg.radius)
    const a1 = Math.atan2(seg.startY - cy, seg.startX - cx)
    const a2 = Math.atan2(seg.endY - cy, seg.endX - cx)
    const isCw = seg.rotation === 'cw'
    let delta = isCw ? a1 - a2 : a2 - a1
    while (delta < 0) delta += 2 * Math.PI
    while (delta > 2 * Math.PI) delta -= 2 * Math.PI
    const arcLen = r * delta
    const n = Math.max(2, Math.ceil(arcLen / step))
    const pts: Point2D[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = a1 + (isCw ? -t * delta : t * delta)
      pts.push({
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
      })
    }
    return pts
  }

  // スパイラル: 始点・終点の直線近似（第一版）。厳密なクロソイド展開は今後追加。
  return [
    { x: seg.startX, y: seg.startY },
    { x: seg.endX, y: seg.endY },
  ]
}

// 複数セグメントをつないだ一本のポリライン点列を返す
export function sampleAlignment(segments: AlignmentSegment[], step?: number): Point2D[] {
  const out: Point2D[] = []
  for (let i = 0; i < segments.length; i++) {
    const pts = sampleSegment(segments[i], step)
    if (i === 0) {
      out.push(...pts)
    } else {
      // 直前セグメントの終点と重複するので先頭を除く
      out.push(...pts.slice(1))
    }
  }
  return out
}
