// 幾何計算ユーティリティ

import type { Point3D, OffsetPoint } from './types'

// 2点間の距離を計算
export function distance2D(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return Math.sqrt(dx * dx + dy * dy)
}

// 線分の方向ベクトル（正規化）
export function normalizedDirection(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { dx: number; dy: number } {
  const len = distance2D(from, to)
  if (len === 0) return { dx: 0, dy: 0 }
  return {
    dx: (to.x - from.x) / len,
    dy: (to.y - from.y) / len,
  }
}

// 左90度回転（法線ベクトル）
export function rotateLeft90(dir: { dx: number; dy: number }): { dx: number; dy: number } {
  return { dx: -dir.dy, dy: dir.dx }
}

// 右90度回転（法線ベクトル）
export function rotateRight90(dir: { dx: number; dy: number }): { dx: number; dy: number } {
  return { dx: dir.dy, dy: -dir.dx }
}

// 点を指定方向にオフセット
export function offsetPoint(
  point: Point3D,
  direction: { dx: number; dy: number },
  distance: number
): Point3D {
  return {
    id: point.id,
    x: point.x + direction.dx * distance,
    y: point.y + direction.dy * distance,
    z: point.z,
  }
}

// 線形の各点を左右にオフセット
export function offsetLine(
  vertices: Point3D[],
  offsetDistance: number
): OffsetPoint[] {
  if (vertices.length === 0) return []
  if (vertices.length === 1) {
    // 単一点の場合、任意の方向にオフセット
    const point = vertices[0]
    return [{
      original: point,
      left: { ...point, id: `${point.id}_L`, x: point.x - offsetDistance },
      right: { ...point, id: `${point.id}_R`, x: point.x + offsetDistance },
    }]
  }

  const result: OffsetPoint[] = []

  for (let i = 0; i < vertices.length; i++) {
    const point = vertices[i]
    let normal: { dx: number; dy: number }

    if (i === 0) {
      // 最初の点: 次の点への方向の法線
      const dir = normalizedDirection(vertices[i], vertices[i + 1])
      normal = rotateLeft90(dir)
    } else if (i === vertices.length - 1) {
      // 最後の点: 前の点からの方向の法線
      const dir = normalizedDirection(vertices[i - 1], vertices[i])
      normal = rotateLeft90(dir)
    } else {
      // 中間点: 前後のセグメントの法線の平均（二等分線）
      const dir1 = normalizedDirection(vertices[i - 1], vertices[i])
      const dir2 = normalizedDirection(vertices[i], vertices[i + 1])
      const normal1 = rotateLeft90(dir1)
      const normal2 = rotateLeft90(dir2)

      // 法線の平均
      let avgDx = (normal1.dx + normal2.dx) / 2
      let avgDy = (normal1.dy + normal2.dy) / 2
      const avgLen = Math.sqrt(avgDx * avgDx + avgDy * avgDy)

      if (avgLen > 0.0001) {
        avgDx /= avgLen
        avgDy /= avgLen
      } else {
        // ほぼ直線の場合
        avgDx = normal1.dx
        avgDy = normal1.dy
      }

      normal = { dx: avgDx, dy: avgDy }
    }

    result.push({
      original: point,
      left: {
        id: `${point.id}_L`,
        x: point.x + normal.dx * offsetDistance,
        y: point.y + normal.dy * offsetDistance,
        z: point.z,
      },
      right: {
        id: `${point.id}_R`,
        x: point.x - normal.dx * offsetDistance,
        y: point.y - normal.dy * offsetDistance,
        z: point.z,
      },
    })
  }

  return result
}

// 2直線の交点を計算
// 線1: p1 + t * d1, 線2: p2 + s * d2
export function lineIntersection(
  p1: { x: number; y: number },
  d1: { dx: number; dy: number },
  p2: { x: number; y: number },
  d2: { dx: number; dy: number }
): { x: number; y: number; t: number; s: number } | null {
  const cross = d1.dx * d2.dy - d1.dy * d2.dx
  if (Math.abs(cross) < 0.0001) {
    // 平行
    return null
  }

  const dx = p2.x - p1.x
  const dy = p2.y - p1.y

  const t = (dx * d2.dy - dy * d2.dx) / cross
  const s = (dx * d1.dy - dy * d1.dx) / cross

  return {
    x: p1.x + t * d1.dx,
    y: p1.y + t * d1.dy,
    t,
    s,
  }
}

// 折れ点でのオフセット線の交点を計算してトリミング/延長
export function adjustOffsetLinesAtCorner(
  offsetPoints: OffsetPoint[],
  index: number
): void {
  if (index <= 0 || index >= offsetPoints.length - 1) return

  const prev = offsetPoints[index - 1]
  const current = offsetPoints[index]
  const next = offsetPoints[index + 1]

  // 左側の調整
  const leftDir1 = normalizedDirection(prev.left, current.left)
  const leftDir2 = normalizedDirection(current.left, next.left)
  const leftIntersection = lineIntersection(
    prev.left,
    leftDir1,
    current.left,
    leftDir2
  )
  if (leftIntersection) {
    current.left.x = leftIntersection.x
    current.left.y = leftIntersection.y
  }

  // 右側の調整
  const rightDir1 = normalizedDirection(prev.right, current.right)
  const rightDir2 = normalizedDirection(current.right, next.right)
  const rightIntersection = lineIntersection(
    prev.right,
    rightDir1,
    current.right,
    rightDir2
  )
  if (rightIntersection) {
    current.right.x = rightIntersection.x
    current.right.y = rightIntersection.y
  }
}

// 点と線分の最短距離
export function pointToSegmentDistance(
  point: { x: number; y: number },
  segStart: { x: number; y: number },
  segEnd: { x: number; y: number }
): number {
  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const lenSq = dx * dx + dy * dy

  if (lenSq === 0) {
    return distance2D(point, segStart)
  }

  let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))

  const projection = {
    x: segStart.x + t * dx,
    y: segStart.y + t * dy,
  }

  return distance2D(point, projection)
}

// 線分上の点を距離で補間
export function interpolatePointOnSegment(
  start: Point3D,
  end: Point3D,
  distance: number
): Point3D {
  const totalDist = distance2D(start, end)
  if (totalDist === 0) return { ...start }

  const t = distance / totalDist
  return {
    id: `interp_${start.id}_${end.id}_${distance.toFixed(2)}`,
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  }
}

// 2点間の高さを線形補間
export function interpolateZ(
  z1: number,
  z2: number,
  t: number
): number {
  return z1 + (z2 - z1) * t
}
