// 帯置計画の幾何計算（XY 平面直角座標で計算）
//
// 用語:
//  - 基線 (baseline / axis): ユーザーが指定した 2 点で定義する直線
//  - 枝 (branch): 基線に垂直な帯線
//  - 平行線 (parallel): 基線に平行な帯線
//  - WB (帯下底幅): 帯断面の下底幅。枝/垂直線は基線本体と重ねない（端部から配置）

export interface XY {
  x: number
  y: number
}

const EPS = 1e-9

function dot(a: XY, b: XY): number {
  return a.x * b.x + a.y * b.y
}
function add(a: XY, b: XY): XY {
  return { x: a.x + b.x, y: a.y + b.y }
}
function sub(a: XY, b: XY): XY {
  return { x: a.x - b.x, y: a.y - b.y }
}
function scale(a: XY, s: number): XY {
  return { x: a.x * s, y: a.y * s }
}
function normalize(a: XY): XY {
  const m = Math.hypot(a.x, a.y)
  return m < EPS ? { x: 0, y: 0 } : { x: a.x / m, y: a.y / m }
}
function perp(a: XY): XY {
  // 90° 反時計回り
  return { x: -a.y, y: a.x }
}
function distance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// 線分長
export function segmentLength(seg: [XY, XY]): number {
  return distance(seg[0], seg[1])
}

// 無限直線（origin を通り direction 方向）と多角形の内部部分を返す。
// 多角形は閉じた単純ポリゴン（最後と最初は自動接続）。
// 偶数個の交点を s（パラメータ）でソートしてペアにし、内部区間を返す。
export function clipInfiniteLineToPolygon(
  origin: XY,
  direction: XY,
  polygon: XY[],
): [XY, XY][] {
  if (polygon.length < 3) return []
  const d = normalize(direction)
  if (d.x === 0 && d.y === 0) return []

  const ts: number[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const e = sub(b, a) // edge vector
    // line: origin + t·d
    // edge: a + s·e, s∈[0,1]
    // 解: origin + t·d = a + s·e  →  t·d - s·e = a - origin
    // 行列式: det = d.x·(-e.y) - d.y·(-e.x) = -d.x·e.y + d.y·e.x = d.y·e.x - d.x·e.y
    const det = d.y * e.x - d.x * e.y
    if (Math.abs(det) < EPS) continue // 平行
    const ao = sub(a, origin)
    // クラメル
    // t = ( (a.x-origin.x)·(-e.y) - (a.y-origin.y)·(-e.x) ) / det
    //   = ( -(a.x-origin.x)·e.y + (a.y-origin.y)·e.x ) / det
    const t = (ao.y * e.x - ao.x * e.y) / det
    // s = ( d.x·(a.y-origin.y) - d.y·(a.x-origin.x) ) / det
    const s = (d.x * ao.y - d.y * ao.x) / det
    if (s >= -EPS && s <= 1 + EPS) {
      ts.push(t)
    }
  }

  if (ts.length < 2) return []
  ts.sort((a, b) => a - b)

  // 重複排除（頂点で 2 辺と交わるケースなど）
  const cleaned: number[] = []
  for (const t of ts) {
    if (cleaned.length === 0 || Math.abs(t - cleaned[cleaned.length - 1]) > 1e-6) {
      cleaned.push(t)
    }
  }
  // 偶数化（奇数なら最後の 1 個を切る）
  const n = Math.floor(cleaned.length / 2) * 2
  const segments: [XY, XY][] = []
  for (let i = 0; i < n; i += 2) {
    const t1 = cleaned[i]
    const t2 = cleaned[i + 1]
    if (t2 - t1 < EPS) continue
    segments.push([add(origin, scale(d, t1)), add(origin, scale(d, t2))])
  }
  return segments
}

// 線分（端点 a,b）と多角形の内部部分（クリッピング）
export function clipSegmentToPolygon(a: XY, b: XY, polygon: XY[]): [XY, XY][] {
  const dir = sub(b, a)
  const len = Math.hypot(dir.x, dir.y)
  if (len < EPS) return []
  const segs = clipInfiniteLineToPolygon(a, dir, polygon)
  // origin=a, direction=normalized(b-a) → t∈[0, len] が線分内
  const result: [XY, XY][] = []
  for (const [s1, s2] of segs) {
    // s1, s2 は a を origin、direction = normalized(dir) の t 値で計算済み
    // ここで s1, s2 は XY 座標。もう一度 a 起点でクランプ
    const t1 = dot(sub(s1, a), normalize(dir))
    const t2 = dot(sub(s2, a), normalize(dir))
    const lo = Math.max(0, Math.min(t1, t2))
    const hi = Math.min(len, Math.max(t1, t2))
    if (hi - lo > EPS) {
      const u = normalize(dir)
      result.push([add(a, scale(u, lo)), add(a, scale(u, hi))])
    }
  }
  return result
}

export interface BranchPatternResult {
  axisSegments: [XY, XY][] // 軸（基線）を多角形でクリップしたもの
  branchSegments: [XY, XY][] // 軸に垂直な枝線（多角形でクリップ済み）
}

// 枝状の帯配置を生成
// p1, p2: 軸の 2 点（軸の方向と長さを定義）
// polygon: 工事区域
// interval: 軸方向に沿った枝の配置間隔 (m)
// wb: 帯下底幅 WB (m)。各枝は軸中心線から ±wb/2 の位置から始まり外側へ伸びる
export function generateBranchStrips(
  p1: XY,
  p2: XY,
  polygon: XY[],
  interval: number,
  wb: number,
): BranchPatternResult {
  if (interval <= 0 || polygon.length < 3) {
    return { axisSegments: [], branchSegments: [] }
  }
  const axisDir = normalize(sub(p2, p1))
  if (axisDir.x === 0 && axisDir.y === 0) {
    return { axisSegments: [], branchSegments: [] }
  }
  const perpDir = perp(axisDir) // 軸に垂直（CCW 90°）

  // 軸を多角形でクリップ（無限直線として）
  const axisSegments = clipInfiniteLineToPolygon(p1, axisDir, polygon)

  // 軸の多角形内範囲を取得（軸方向のパラメータ t 範囲）
  let tMin = Infinity
  let tMax = -Infinity
  for (const seg of axisSegments) {
    for (const pt of seg) {
      const t = dot(sub(pt, p1), axisDir)
      tMin = Math.min(tMin, t)
      tMax = Math.max(tMax, t)
    }
  }
  if (!isFinite(tMin) || !isFinite(tMax)) {
    return { axisSegments, branchSegments: [] }
  }

  const branchSegments: [XY, XY][] = []
  const halfWb = wb / 2
  // 軸方向の中央（多角形内中央）から両側に interval 間隔で配置
  const tCenter = (tMin + tMax) / 2
  // 中央から interval 刻みでずらした t 値を生成
  const tValues: number[] = []
  for (let k = -1000; k <= 1000; k++) {
    const t = tCenter + k * interval
    if (t < tMin - EPS || t > tMax + EPS) continue
    tValues.push(t)
  }
  tValues.sort((a, b) => a - b)

  for (const t of tValues) {
    const axisPoint = add(p1, scale(axisDir, t))
    // +側の枝: 軸中心から +perpDir·halfWb の位置から +perpDir 方向へ延びる
    {
      const start = add(axisPoint, scale(perpDir, halfWb))
      const segs = clipInfiniteLineToPolygon(start, perpDir, polygon)
      for (const [s1, s2] of segs) {
        // start を境にした +perpDir 側のみ採用（軸を跨がない）
        const t1 = dot(sub(s1, start), perpDir)
        const t2 = dot(sub(s2, start), perpDir)
        const lo = Math.min(t1, t2)
        const hi = Math.max(t1, t2)
        const clamped: [number, number] = [Math.max(lo, 0), hi]
        if (clamped[1] - clamped[0] > EPS) {
          branchSegments.push([
            add(start, scale(perpDir, clamped[0])),
            add(start, scale(perpDir, clamped[1])),
          ])
        }
      }
    }
    // -側の枝
    {
      const start = add(axisPoint, scale(perpDir, -halfWb))
      const negDir = scale(perpDir, -1)
      const segs = clipInfiniteLineToPolygon(start, negDir, polygon)
      for (const [s1, s2] of segs) {
        const t1 = dot(sub(s1, start), negDir)
        const t2 = dot(sub(s2, start), negDir)
        const lo = Math.min(t1, t2)
        const hi = Math.max(t1, t2)
        const clamped: [number, number] = [Math.max(lo, 0), hi]
        if (clamped[1] - clamped[0] > EPS) {
          branchSegments.push([
            add(start, scale(negDir, clamped[0])),
            add(start, scale(negDir, clamped[1])),
          ])
        }
      }
    }
  }

  return { axisSegments, branchSegments }
}

export interface GridPatternResult {
  parallelSegments: [XY, XY][] // 基線に平行な線（基線自身を含む）
  perpendicularSegments: [XY, XY][] // 基線に垂直な線
}

// 格子状の帯配置を生成
// p1, p2: 基線の 2 点
// interval: 平行線・垂直線の間隔 (m)
export function generateGridStrips(
  p1: XY,
  p2: XY,
  polygon: XY[],
  interval: number,
): GridPatternResult {
  if (interval <= 0 || polygon.length < 3) {
    return { parallelSegments: [], perpendicularSegments: [] }
  }
  const baseDir = normalize(sub(p2, p1))
  if (baseDir.x === 0 && baseDir.y === 0) {
    return { parallelSegments: [], perpendicularSegments: [] }
  }
  const perpDir = perp(baseDir)

  // 多角形の各頂点を基線方向と垂直方向に投影し、範囲を求める
  let uMin = Infinity, uMax = -Infinity // 基線方向
  let vMin = Infinity, vMax = -Infinity // 垂直方向
  for (const pt of polygon) {
    const rel = sub(pt, p1)
    const u = dot(rel, baseDir)
    const v = dot(rel, perpDir)
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }

  const parallelSegments: [XY, XY][] = []
  const perpendicularSegments: [XY, XY][] = []

  // 平行線: 基線（v=0）を中心に上下 interval 刻みで配置
  for (let k = Math.floor(vMin / interval); k <= Math.ceil(vMax / interval); k++) {
    const v = k * interval
    if (v < vMin - EPS || v > vMax + EPS) continue
    const origin = add(p1, scale(perpDir, v))
    const segs = clipInfiniteLineToPolygon(origin, baseDir, polygon)
    parallelSegments.push(...segs)
  }

  // 垂直線: 基線方向 u=0 を中心に左右 interval 刻みで配置
  for (let k = Math.floor(uMin / interval); k <= Math.ceil(uMax / interval); k++) {
    const u = k * interval
    if (u < uMin - EPS || u > uMax + EPS) continue
    const origin = add(p1, scale(baseDir, u))
    const segs = clipInfiniteLineToPolygon(origin, perpDir, polygon)
    perpendicularSegments.push(...segs)
  }

  return { parallelSegments, perpendicularSegments }
}

export function totalLength(segments: [XY, XY][]): number {
  return segments.reduce((sum, seg) => sum + segmentLength(seg), 0)
}

// 折れ線（点列）を一定幅でバッファして帯ポリゴン（左輪→右輪逆順）を作る。
// halfWidth は中心線からの片側オフセット距離（m）。
// 端部は square（線方向に対して垂直のままカット）、内部頂点は miter（先端制限あり）。
export function bufferPolyline(line: XY[], halfWidth: number): XY[] | null {
  if (line.length < 2 || halfWidth <= 0) return null
  const MITER_LIMIT = 5 // cosHalf がこの逆数以下になる鋭角は端を切り詰める
  const left: XY[] = []
  const right: XY[] = []
  for (let i = 0; i < line.length; i++) {
    let nm: XY
    let dist = halfWidth
    if (i === 0) {
      const d = normalize(sub(line[1], line[0]))
      nm = perp(d)
    } else if (i === line.length - 1) {
      const d = normalize(sub(line[i], line[i - 1]))
      nm = perp(d)
    } else {
      const d1 = normalize(sub(line[i], line[i - 1]))
      const d2 = normalize(sub(line[i + 1], line[i]))
      const n1 = perp(d1)
      const n2 = perp(d2)
      const sx = n1.x + n2.x
      const sy = n1.y + n2.y
      const m = Math.hypot(sx, sy)
      if (m < EPS) {
        // 180° 折返し
        nm = n1
      } else {
        nm = { x: sx / m, y: sy / m }
        const cosHalf = nm.x * n1.x + nm.y * n1.y // ∈ (0, 1]
        if (cosHalf > 1 / MITER_LIMIT) {
          dist = halfWidth / cosHalf
        } else {
          dist = halfWidth * MITER_LIMIT
        }
      }
    }
    left.push(add(line[i], scale(nm, dist)))
    right.push(sub(line[i], scale(nm, dist)))
  }
  return [...left, ...right.reverse()]
}

// 線分の集まりをそれぞれ独立した帯ポリゴンに変換
export function bufferSegments(segments: [XY, XY][], halfWidth: number): XY[][] {
  const out: XY[][] = []
  for (const seg of segments) {
    const poly = bufferPolyline([seg[0], seg[1]], halfWidth)
    if (poly) out.push(poly)
  }
  return out
}

// 折れ線の総延長
export function polylineLength(line: XY[]): number {
  let total = 0
  for (let i = 1; i < line.length; i++) {
    total += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y)
  }
  return total
}

// 折れ線の中点（総延長の半分の位置）
export function polylineMidpoint(line: XY[]): XY | null {
  if (line.length === 0) return null
  if (line.length === 1) return line[0]
  const total = polylineLength(line)
  if (total < EPS) return line[0]
  const target = total / 2
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const segLen = Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y)
    if (acc + segLen >= target) {
      const t = segLen > 0 ? (target - acc) / segLen : 0
      return {
        x: line[i - 1].x + (line[i].x - line[i - 1].x) * t,
        y: line[i - 1].y + (line[i].y - line[i - 1].y) * t,
      }
    }
    acc += segLen
  }
  return line[line.length - 1]
}

// 始点 anchor から target 方向に向かう線分長を unit の整数倍に丸めた終点を返す。
// k=round(d/unit) を min 1 でクランプ。unit<=0 や距離 0 の場合は target をそのまま返す。
export function snapEndpointToMultiple(anchor: XY, target: XY, unit: number): XY {
  if (unit <= 0) return target
  const dx = target.x - anchor.x
  const dy = target.y - anchor.y
  const d = Math.hypot(dx, dy)
  if (d < EPS) return target
  const k = Math.max(1, Math.round(d / unit))
  const ratio = (k * unit) / d
  return { x: anchor.x + dx * ratio, y: anchor.y + dy * ratio }
}

// 折れ線上で点 p に最も近い位置を求める
export function nearestPointOnPolyline(
  p: XY,
  line: XY[],
): { point: XY; segIdx: number; t: number; dist: number } | null {
  if (line.length < 2) return null
  let best: { point: XY; segIdx: number; t: number; dist: number } | null = null
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const ab = sub(b, a)
    const ap = sub(p, a)
    const len2 = ab.x * ab.x + ab.y * ab.y
    if (len2 < EPS) continue
    let t = (ap.x * ab.x + ap.y * ab.y) / len2
    t = Math.max(0, Math.min(1, t))
    const point = { x: a.x + ab.x * t, y: a.y + ab.y * t }
    const d = Math.hypot(p.x - point.x, p.y - point.y)
    if (best === null || d < best.dist) {
      best = { point, segIdx: i - 1, t, dist: d }
    }
  }
  return best
}

// 折れ線を offset 距離だけ片側オフセットした折れ線を返す（左+, 右-）
// 内部頂点は miter で結合（先端制限あり）
export function offsetPolyline(line: XY[], offset: number): XY[] | null {
  if (line.length < 2) return null
  if (Math.abs(offset) < EPS) return line.map((p) => ({ ...p }))
  const MITER_LIMIT = 5
  const result: XY[] = []
  for (let i = 0; i < line.length; i++) {
    let nm: XY
    let dist = offset
    if (i === 0) {
      const d = normalize(sub(line[1], line[0]))
      nm = perp(d)
    } else if (i === line.length - 1) {
      const d = normalize(sub(line[i], line[i - 1]))
      nm = perp(d)
    } else {
      const d1 = normalize(sub(line[i], line[i - 1]))
      const d2 = normalize(sub(line[i + 1], line[i]))
      const n1 = perp(d1)
      const n2 = perp(d2)
      const sx = n1.x + n2.x
      const sy = n1.y + n2.y
      const m = Math.hypot(sx, sy)
      if (m < EPS) {
        nm = n1
      } else {
        nm = { x: sx / m, y: sy / m }
        const cosHalf = nm.x * n1.x + nm.y * n1.y
        if (cosHalf > 1 / MITER_LIMIT) {
          dist = offset / cosHalf
        } else {
          dist = offset * MITER_LIMIT * Math.sign(offset || 1)
        }
      }
    }
    result.push(add(line[i], scale(nm, dist)))
  }
  return result
}

// 折れ線の指定セグメントの単位方向ベクトル
export function polylineSegmentDirection(line: XY[], segIdx: number): XY {
  if (segIdx < 0 || segIdx >= line.length - 1) return { x: 1, y: 0 }
  return normalize(sub(line[segIdx + 1], line[segIdx]))
}
