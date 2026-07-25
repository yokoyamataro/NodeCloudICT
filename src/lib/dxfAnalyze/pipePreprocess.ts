// 配管レイヤの LINE + CIRCLE を「pipe run (連続した配管の 1 本)」に集約する。
//
// 実 DXF (6-3.dxf) 観察:
//   ・配管中心線は連続した LINE の集合 (single LWPOLYLINE では無い)
//   ・LINE 長さ < 3mm ≈ 端末線 (端部のティックマーク) → 除外
//   ・CIRCLE = 管径変更点 → pipe run を切断するマーカー
//
// アルゴリズム:
//   1. LINE を長さでフィルタ
//   2. 端点座標が近い LINE 同士を「接続」とみなしてグラフ化
//   3. 各連結成分を pipe run とする
//   4. 端点が CIRCLE 内 (中心から半径以下) にある場合、そこで切断する
//
// 座標系は DXF そのまま (mm 単位) — 平面直角座標との対応は呼び出し側で行う。

import type { DxfLineEntity, DxfCircleEntity } from './parse'

/** LINE の端点座標をキー化する丸め粒度 (mm)。この距離内は「同じ端点」扱い。 */
const ENDPOINT_SNAP_MM = 0.1

/** これより短い LINE は端末線 (2mm 前後のティック) とみなして除外する。 */
export const PIPE_MIN_LENGTH_MM = 3

export interface PipeRun {
  /** 内部 ID (P1, P2, ...) — AI に渡す時のキーになる */
  id: string
  /** 連続する頂点座標 (順序付き)。DXF 座標系のまま。 */
  vertices: Array<{ x: number; y: number; z: number }>
  /** 総長さ (mm 単位) */
  lengthMm: number
  /** バウンディングボックス中心 (ラベル対応付けで参照) */
  centerX: number
  centerY: number
  /** run 化に使った元 LINE のインデックス (デバッグ用) */
  sourceLineIndices: number[]
}

export interface PipePreprocessResult {
  pipeRuns: PipeRun[]
  /** 端末線として除外した LINE 数 */
  discardedShortLines: number
  /** 管径変更点として認識した CIRCLE 数 */
  diameterChangePoints: number
}

interface Endpoint {
  x: number
  y: number
  z: number
  lineIdx: number
  which: 'start' | 'end'
}

// -----------------------------------------------------------------
// エントリポイント
// -----------------------------------------------------------------
export function buildPipeRuns(
  pipeLines: DxfLineEntity[],
  splitCircles: DxfCircleEntity[],
): PipePreprocessResult {
  // 1) 短い LINE を除外
  const filtered: Array<{ line: DxfLineEntity; origIdx: number; length: number }> = []
  let discarded = 0
  pipeLines.forEach((line, i) => {
    const dx = line.x2 - line.x1
    const dy = line.y2 - line.y1
    const len = Math.hypot(dx, dy)
    if (len < PIPE_MIN_LENGTH_MM) {
      discarded++
      return
    }
    filtered.push({ line, origIdx: i, length: len })
  })

  // 2) 端点をハッシュ化して line index → 端点キー のマップを作る
  //    キー: 丸めた x,y (mm)
  const endpoints: Endpoint[] = []
  filtered.forEach(({ line }, i) => {
    endpoints.push({
      x: line.x1,
      y: line.y1,
      z: line.z1,
      lineIdx: i,
      which: 'start',
    })
    endpoints.push({
      x: line.x2,
      y: line.y2,
      z: line.z2,
      lineIdx: i,
      which: 'end',
    })
  })

  // 3) 端点を snap してキー化。同じキー = 接続。
  const key = (p: { x: number; y: number }) =>
    `${Math.round(p.x / ENDPOINT_SNAP_MM)}:${Math.round(p.y / ENDPOINT_SNAP_MM)}`
  const byKey = new Map<string, Endpoint[]>()
  for (const ep of endpoints) {
    const k = key(ep)
    const arr = byKey.get(k) ?? []
    arr.push(ep)
    byKey.set(k, arr)
  }

  // 4) CIRCLE 位置を「pipe run を切断すべき端点」として登録
  //    CIRCLE 中心に近い端点は「別 run」に分ける
  const cutKeys = new Set<string>()
  for (const c of splitCircles) {
    // 半径 r 内の端点を全て「切断対象」に
    for (const ep of endpoints) {
      const dx = ep.x - c.cx
      const dy = ep.y - c.cy
      if (Math.hypot(dx, dy) <= c.radius * 1.5) {
        cutKeys.add(key(ep))
      }
    }
  }

  // 5) Union-Find で LINE を連結成分にまとめる
  const parent = filtered.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (const [k, eps] of byKey.entries()) {
    if (cutKeys.has(k)) continue // 切断点では union しない
    if (eps.length < 2) continue
    // 同一端点にある全 LINE を union
    const base = eps[0].lineIdx
    for (let i = 1; i < eps.length; i++) union(base, eps[i].lineIdx)
  }

  // 6) 連結成分ごとに LINE を集めて、順序付き頂点列を作る (端点連結を辿る)
  const groups = new Map<number, number[]>()
  filtered.forEach((_, i) => {
    const r = find(i)
    const arr = groups.get(r) ?? []
    arr.push(i)
    groups.set(r, arr)
  })

  const runs: PipeRun[] = []
  let runIdCounter = 1
  for (const lineIdxs of groups.values()) {
    const vertices = orderVertices(lineIdxs, filtered, byKey, cutKeys)
    if (vertices.length < 2) continue
    let length = 0
    for (let i = 0; i < vertices.length - 1; i++) {
      const dx = vertices[i + 1].x - vertices[i].x
      const dy = vertices[i + 1].y - vertices[i].y
      length += Math.hypot(dx, dy)
    }
    const cx =
      vertices.reduce((s, v) => s + v.x, 0) / vertices.length
    const cy =
      vertices.reduce((s, v) => s + v.y, 0) / vertices.length
    runs.push({
      id: `P${runIdCounter++}`,
      vertices,
      lengthMm: length,
      centerX: cx,
      centerY: cy,
      sourceLineIndices: lineIdxs.map((i) => filtered[i].origIdx),
    })
  }

  return {
    pipeRuns: runs,
    discardedShortLines: discarded,
    diameterChangePoints: splitCircles.length,
  }
}

// -----------------------------------------------------------------
// 連結成分の LINE 群を、端点をたどって順序付き頂点列に変換する。
// 分岐 (T 字) がある場合は最長パスを採る。
// -----------------------------------------------------------------
function orderVertices(
  lineIdxs: number[],
  filtered: Array<{ line: DxfLineEntity; origIdx: number; length: number }>,
  byKey: Map<string, Endpoint[]>,
  cutKeys: Set<string>,
): Array<{ x: number; y: number; z: number }> {
  if (lineIdxs.length === 0) return []
  if (lineIdxs.length === 1) {
    const l = filtered[lineIdxs[0]].line
    return [
      { x: l.x1, y: l.y1, z: l.z1 },
      { x: l.x2, y: l.y2, z: l.z2 },
    ]
  }

  const key = (p: { x: number; y: number }) =>
    `${Math.round(p.x / ENDPOINT_SNAP_MM)}:${Math.round(p.y / ENDPOINT_SNAP_MM)}`

  // 各 line の start/end キー
  const lineKeys = new Map<number, [string, string]>()
  for (const i of lineIdxs) {
    const l = filtered[i].line
    lineKeys.set(i, [key({ x: l.x1, y: l.y1 }), key({ x: l.x2, y: l.y2 })])
  }

  // 各 line index の残数 (次数)
  const degree = new Map<string, number>()
  for (const [, [k1, k2]] of lineKeys) {
    degree.set(k1, (degree.get(k1) ?? 0) + 1)
    degree.set(k2, (degree.get(k2) ?? 0) + 1)
  }

  // 終端 (次数 1) の点を開始点とする。分岐なしなら 2 個、環状なら 0 個。
  let startKey: string | null = null
  for (const [k, d] of degree.entries()) {
    if (d === 1) {
      startKey = k
      break
    }
  }
  // 環状なら任意の 1 点から始める
  if (!startKey) {
    startKey = lineKeys.get(lineIdxs[0])![0]
  }

  // 順にたどる
  const used = new Set<number>()
  const remaining = new Set(lineIdxs)
  const vertices: Array<{ x: number; y: number; z: number }> = []
  let currentKey = startKey

  // 開始点の座標を取得
  const startEps = byKey.get(startKey) ?? []
  if (startEps.length > 0) {
    const e = startEps[0]
    vertices.push({ x: e.x, y: e.y, z: e.z })
  }

  let safety = lineIdxs.length + 1
  while (remaining.size > 0 && safety-- > 0) {
    // 現在 key に接続する未使用 line を探す
    let nextLine: number | null = null
    for (const i of remaining) {
      const [k1, k2] = lineKeys.get(i)!
      if (k1 === currentKey || k2 === currentKey) {
        nextLine = i
        break
      }
    }
    if (nextLine == null) break

    const [k1, k2] = lineKeys.get(nextLine)!
    const line = filtered[nextLine].line
    // 進行方向: current が k1 側なら k2 が次、逆なら k1 が次
    if (k1 === currentKey) {
      vertices.push({ x: line.x2, y: line.y2, z: line.z2 })
      currentKey = k2
    } else {
      vertices.push({ x: line.x1, y: line.y1, z: line.z1 })
      currentKey = k1
    }
    remaining.delete(nextLine)
    used.add(nextLine)

    // 切断点に到達したら中断
    if (cutKeys.has(currentKey)) break
  }

  return vertices
}
