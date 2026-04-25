// LandXML の TIN サーフェス同士・内同士の三角形重複検出。
//
// ルール:
//  - 二つの三角形の「内部」が一部でも重なっていればエラー
//  - エッジ・頂点だけを共有している（=隣接）状態は OK
//  - 同一三角形の自己ペアは検査しない
//
// アルゴリズム: バウンディングボックス事前判定 → Sutherland-Hodgman 多角形クリッピング
// で交差多角形を求め、その面積が閾値以上なら重複とみなす。
//
// 入力する三角形の頂点座標は (x=北, y=東) の 2D で扱う（Z は無視）。

export interface OverlapPoint {
  x: number
  y: number
}

export interface OverlapTriangle {
  /** 表示用: 配列インデックス */
  index: number
  /** 三角形の頂点座標（CCW でも CW でも可。内部で正規化する） */
  vertices: [OverlapPoint, OverlapPoint, OverlapPoint]
}

export interface OverlapInput {
  /** 識別キー（サーフェス id 等。自己ペア判定には使わない） */
  surfaceId: string
  /** 表示用名 */
  surfaceName: string
  triangles: OverlapTriangle[]
}

export interface OverlapPair {
  aSurfaceId: string
  aSurfaceName: string
  aTriangleIndex: number
  bSurfaceId: string
  bSurfaceName: string
  bTriangleIndex: number
  /** 重なり面積 */
  overlapArea: number
}

export interface OverlapResult {
  pairs: OverlapPair[]
  /** 「片方の三角」 = 後勝ち（surface_idx, triangle_idx の大きい方）に集約したマーク */
  errorTriangles: { surfaceId: string; triangleIndex: number }[]
  /** 検査した三角形ペア数 */
  pairsChecked: number
}

/** 重複検出のメインエントリ */
export function detectOverlaps(
  inputs: OverlapInput[],
  options: { areaEps?: number } = {},
): OverlapResult {
  const areaEps = options.areaEps ?? 1e-6 // 1mm² 程度より小さい重なりは無視

  // 全三角形を「ボックス + 正規化済み頂点」のフラット配列に展開
  type Item = {
    surfaceIndex: number // inputs 配列の index
    triangleIndex: number // 各 surface 内の index
    surfaceId: string
    surfaceName: string
    bbox: [number, number, number, number] // [minX, minY, maxX, maxY]
    verts: [OverlapPoint, OverlapPoint, OverlapPoint] // CCW に整列済み
  }
  const items: Item[] = []
  for (let si = 0; si < inputs.length; si++) {
    const surf = inputs[si]
    for (const t of surf.triangles) {
      const v = ensureCCW(t.vertices)
      const bbox: [number, number, number, number] = [
        Math.min(v[0].x, v[1].x, v[2].x),
        Math.min(v[0].y, v[1].y, v[2].y),
        Math.max(v[0].x, v[1].x, v[2].x),
        Math.max(v[0].y, v[1].y, v[2].y),
      ]
      items.push({
        surfaceIndex: si,
        triangleIndex: t.index,
        surfaceId: surf.surfaceId,
        surfaceName: surf.surfaceName,
        bbox,
        verts: v,
      })
    }
  }

  const pairs: OverlapPair[] = []
  const errorSet = new Set<string>()
  let pairsChecked = 0

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]
      const B = items[j]
      // バウンディングボックスが重ならなければ即スキップ
      if (
        A.bbox[2] < B.bbox[0] ||
        B.bbox[2] < A.bbox[0] ||
        A.bbox[3] < B.bbox[1] ||
        B.bbox[3] < A.bbox[1]
      ) {
        continue
      }
      pairsChecked++

      const clipped = clipTriangleByTriangle(A.verts, B.verts)
      if (clipped.length < 3) continue
      const area = polygonArea(clipped)
      if (area > areaEps) {
        pairs.push({
          aSurfaceId: A.surfaceId,
          aSurfaceName: A.surfaceName,
          aTriangleIndex: A.triangleIndex,
          bSurfaceId: B.surfaceId,
          bSurfaceName: B.surfaceName,
          bTriangleIndex: B.triangleIndex,
          overlapArea: area,
        })
        // 「片方」= surfaceIndex / triangleIndex が大きい側をエラー側として集約
        const bSide =
          A.surfaceIndex < B.surfaceIndex ||
          (A.surfaceIndex === B.surfaceIndex && A.triangleIndex < B.triangleIndex)
        const target = bSide ? B : A
        errorSet.add(`${target.surfaceId}::${target.triangleIndex}`)
      }
    }
  }

  const errorTriangles = Array.from(errorSet).map((k) => {
    const [surfaceId, idxStr] = k.split('::')
    return { surfaceId, triangleIndex: parseInt(idxStr, 10) }
  })

  return { pairs, errorTriangles, pairsChecked }
}

// 三角形が CW なら頂点順を反転して CCW に揃える（クリッピングの符号判定を統一するため）
function ensureCCW(
  v: [OverlapPoint, OverlapPoint, OverlapPoint],
): [OverlapPoint, OverlapPoint, OverlapPoint] {
  const a = signedArea2(v[0], v[1], v[2])
  if (a < 0) return [v[0], v[2], v[1]]
  return v
}

function signedArea2(a: OverlapPoint, b: OverlapPoint, c: OverlapPoint): number {
  // 2 倍の符号付き面積（正なら CCW）
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

// Sutherland-Hodgman: 凸クリップ多角形（CCW）で対象多角形をクリップ
//   subject, clip ともに CCW 前提
function clipPolygonByConvex(
  subject: OverlapPoint[],
  clip: OverlapPoint[],
): OverlapPoint[] {
  let output = subject
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) return []
    const e1 = clip[i]
    const e2 = clip[(i + 1) % clip.length]
    const input = output
    output = []
    for (let k = 0; k < input.length; k++) {
      const curr = input[k]
      const prev = input[(k - 1 + input.length) % input.length]
      const currIn = isLeftOrOn(e1, e2, curr)
      const prevIn = isLeftOrOn(e1, e2, prev)
      if (currIn) {
        if (!prevIn) {
          const ip = lineIntersect(prev, curr, e1, e2)
          if (ip) output.push(ip)
        }
        output.push(curr)
      } else if (prevIn) {
        const ip = lineIntersect(prev, curr, e1, e2)
        if (ip) output.push(ip)
      }
    }
  }
  return output
}

function clipTriangleByTriangle(
  a: [OverlapPoint, OverlapPoint, OverlapPoint],
  b: [OverlapPoint, OverlapPoint, OverlapPoint],
): OverlapPoint[] {
  return clipPolygonByConvex([a[0], a[1], a[2]], [b[0], b[1], b[2]])
}

// 線分 (e1→e2) の左側 or 線上にあるか（e1, e2 は CCW 多角形の連続頂点）
function isLeftOrOn(e1: OverlapPoint, e2: OverlapPoint, p: OverlapPoint): boolean {
  return (e2.x - e1.x) * (p.y - e1.y) - (e2.y - e1.y) * (p.x - e1.x) >= 0
}

// 2 直線の交点（線分 prev-curr とクリップエッジ e1-e2）
function lineIntersect(
  p1: OverlapPoint,
  p2: OverlapPoint,
  p3: OverlapPoint,
  p4: OverlapPoint,
): OverlapPoint | null {
  const x1 = p1.x,
    y1 = p1.y
  const x2 = p2.x,
    y2 = p2.y
  const x3 = p3.x,
    y3 = p3.y
  const x4 = p4.x,
    y4 = p4.y
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(denom) < 1e-12) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) }
}

// 多角形（CCW）の面積
function polygonArea(poly: OverlapPoint[]): number {
  if (poly.length < 3) return 0
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}
