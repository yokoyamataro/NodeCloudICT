// 建物 を 敷地 に 据える 計算。
//
// 建物 の 形 は 原点 から の 相対距離 で 持って いる ので、敷地 (平面直角座標) に
// 載せる には 平行移動 (E, N) と 回転 θ の 3 つ を 決める 必要 が ある。
// 数値 を 直接 触る と まず 合わない ので、現地 の 測り方 に 沿った 2 通り を 用意 する。
//
//   1. 3 点指定 … 建物 の 角 3 つ を 選び、それぞれ が どの 境界線 から
//                  いくつ 離れて いる か を 入れる。 3 つ の 条件 で 3 つ の
//                  自由度 が 決まる。
//   2. 1 辺平行 … 建物 の 1 辺 を 境界線 に 平行 に し、離れ と 沿い の
//                  距離 で 位置 を 決める。 角地 で ない 敷地 は こちら が 早い。
//
// 出た 答え は site.offsetE / offsetN / rotationDeg に 書き戻す ので、
// 描画 側 は 今まで どおり その 3 つ だけ 見れば よい。

import type { Move, Pt } from './floorPlanTypes'
import { outlineFromMoves } from './floorPlanTypes'

/** 現地 の 座標 (E=東 / N=北 の メートル) */
export interface EN {
  e: number
  n: number
}

export interface Placement {
  offsetE: number
  offsetN: number
  rotationDeg: number
}

/** 敷地 の 構成点 (X=北 / Y=東) を E/N に 直す */
export function siteRing(points: { x: number; y: number }[]): EN[] {
  return points.map((p) => ({ e: p.y, n: p.x }))
}

/** 多角形 が 反時計回り か */
function isCcw(ring: EN[]): boolean {
  let s = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    s += a.e * b.n - b.e * a.n
  }
  return s > 0
}

/** i 番目 の 境界線 (点 i → 点 i+1) */
export function siteEdge(ring: EN[], i: number): { a: EN; b: EN } | null {
  if (ring.length < 2) return null
  const a = ring[i % ring.length]
  const b = ring[(i + 1) % ring.length]
  return { a, b }
}

/**
 * 境界線 から の 距離。 敷地 の 内側 を 正 と する。
 * 図面 に 書く 離れ は 内側 の 数字 な ので、その まま 入れられる ように。
 */
export function insideDistance(ring: EN[], edgeIndex: number, p: EN): number {
  const e = siteEdge(ring, edgeIndex)
  if (!e) return 0
  const dx = e.b.e - e.a.e
  const dy = e.b.n - e.a.n
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return 0
  // 左手側 が 内側 に なる のは 反時計回り の とき
  const sign = isCcw(ring) ? 1 : -1
  return (sign * ((p.e - e.a.e) * dy - (p.n - e.a.n) * dx)) / len * -1
}

/** 境界線 の 上 に 下ろした 垂線 の 足 */
export function footOnEdge(ring: EN[], edgeIndex: number, p: EN): EN | null {
  const e = siteEdge(ring, edgeIndex)
  if (!e) return null
  const dx = e.b.e - e.a.e
  const dy = e.b.n - e.a.n
  const L2 = dx * dx + dy * dy
  if (L2 < 1e-12) return null
  const t = ((p.e - e.a.e) * dx + (p.n - e.a.n) * dy) / L2
  return { e: e.a.e + dx * t, n: e.a.n + dy * t }
}

/** 建物 の 頂点 を 現地 に 置く */
export function placeVertex(p: Pt, pl: Placement): EN {
  const t = (pl.rotationDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return {
    e: pl.offsetE + p.x * cos - p.y * sin,
    n: pl.offsetN + p.x * sin + p.y * cos,
  }
}

/** 敷地 の 重心 (初期値 に 使う) */
export function ringCentroid(ring: EN[]): EN {
  if (ring.length === 0) return { e: 0, n: 0 }
  return {
    e: ring.reduce((s, p) => s + p.e, 0) / ring.length,
    n: ring.reduce((s, p) => s + p.n, 0) / ring.length,
  }
}

/** 建物 の 外形 の 重心 (局所座標) */
function outlineCentroid(pts: Pt[]): Pt {
  if (pts.length === 0) return { x: 0, y: 0 }
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  }
}

/** 建物 の 重心 を 敷地 の 重心 に 合わせた 初期配置 */
export function centerOn(moves: Move[], ring: EN[], rotationDeg = 0): Placement {
  const pts = outlineFromMoves(moves)
  const c = outlineCentroid(pts)
  const g = ringCentroid(ring)
  const t = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return {
    offsetE: g.e - (c.x * cos - c.y * sin),
    offsetN: g.n - (c.x * sin + c.y * cos),
    rotationDeg,
  }
}

// ========================================================================
// 方法 1: 3 点指定
// ========================================================================

export interface PointConstraint {
  id: string
  /** 建物 の 頂点 番号 (外形 の index) */
  vertexIndex: number
  /** 境界線 の 番号 */
  edgeIndex: number
  /** その 境界線 から 内側 へ の 距離 (m) */
  distance: number
}

/**
 * 「この 角 は この 境界線 から ○ m」 を 3 つ 与えて 位置 と 向き を 出す。
 *
 * 式 は 非線形 (回転 が 入る) な ので ガウス・ニュートン で 詰める。
 * 初期値 が 遠い と 別 の 解 に 落ちる ので、呼ぶ 側 が 重心合わせ を 渡す。
 */
export function solveByPoints(
  moves: Move[],
  ring: EN[],
  constraints: PointConstraint[],
  start: Placement,
): { placement: Placement; residual: number } | null {
  const pts = outlineFromMoves(moves)
  const cs = constraints.filter(
    (c) => pts[c.vertexIndex] != null && ring.length >= 3,
  )
  if (cs.length === 0) return null

  const resid = (pl: Placement): number[] =>
    cs.map((c) => insideDistance(ring, c.edgeIndex, placeVertex(pts[c.vertexIndex], pl)) - c.distance)

  let cur = { ...start }
  const H = [0.001, 0.001, 0.01] // 数値微分 の 刻み (m, m, 度)
  for (let iter = 0; iter < 60; iter += 1) {
    const r0 = resid(cur)
    const norm = Math.hypot(...r0)
    if (norm < 1e-7) break

    // 数値 ヤコビアン (cs.length × 3)
    const J: number[][] = r0.map(() => [0, 0, 0])
    const bump: Placement[] = [
      { ...cur, offsetE: cur.offsetE + H[0] },
      { ...cur, offsetN: cur.offsetN + H[1] },
      { ...cur, rotationDeg: cur.rotationDeg + H[2] },
    ]
    for (let k = 0; k < 3; k += 1) {
      const rk = resid(bump[k])
      for (let i = 0; i < r0.length; i += 1) J[i][k] = (rk[i] - r0[i]) / H[k]
    }

    // 正規方程式 JᵀJ d = -Jᵀr (対角 に 少し 足して 暴れ を 抑える)
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]
    const b = [0, 0, 0]
    for (let i = 0; i < r0.length; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        b[k] -= J[i][k] * r0[i]
        for (let l = 0; l < 3; l += 1) A[k][l] += J[i][k] * J[i][l]
      }
    }
    for (let k = 0; k < 3; k += 1) A[k][k] += 1e-6

    const d = solve3(A, b)
    if (!d) break
    cur = {
      offsetE: cur.offsetE + d[0],
      offsetN: cur.offsetN + d[1],
      rotationDeg: cur.rotationDeg + d[2],
    }
    if (Math.hypot(d[0], d[1], d[2] / 100) < 1e-9) break
  }

  const r = resid(cur)
  return {
    placement: {
      offsetE: round3(cur.offsetE),
      offsetN: round3(cur.offsetN),
      rotationDeg: round4(((cur.rotationDeg % 360) + 360) % 360),
    },
    residual: Math.max(...r.map((v) => Math.abs(v))),
  }
}

/** 3 元 の 連立 一次方程式 を 掃き出し で 解く */
function solve3(A: number[][], b: number[]): number[] | null {
  const m = [
    [...A[0], b[0]],
    [...A[1], b[1]],
    [...A[2], b[2]],
  ]
  for (let i = 0; i < 3; i += 1) {
    let piv = i
    for (let j = i + 1; j < 3; j += 1) if (Math.abs(m[j][i]) > Math.abs(m[piv][i])) piv = j
    if (Math.abs(m[piv][i]) < 1e-12) return null
    ;[m[i], m[piv]] = [m[piv], m[i]]
    for (let j = 0; j < 3; j += 1) {
      if (j === i) continue
      const f = m[j][i] / m[i][i]
      for (let k = i; k < 4; k += 1) m[j][k] -= f * m[i][k]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
}

// ========================================================================
// 方法 2: 1 辺平行
// ========================================================================

export interface ParallelSpec {
  /** 建物 の 辺 (moves の index) */
  buildingEdge: number
  /** 平行 に する 境界線 */
  siteEdge: number
  /** 境界線 から 内側 へ の 距離 (m) */
  offset: number
  /** 基点 から 境界線 に 沿って 進む 距離 (m) */
  along: number
  /** 基点 を 境界線 の 終点 側 に する */
  fromEnd: boolean
  /** 建物 の 向き を 180 度 返す */
  flip: boolean
}

/**
 * 1 辺平行 の 下書き。 基点 / 延長 の 先 / 建物 を 置く 位置 を 返す。
 * 図 に 寸法 を 描く ため に 使う。
 */
export function parallelGuides(
  ring: EN[],
  spec: ParallelSpec,
): { base: EN; alongEnd: EN; target: EN } | null {
  const se = siteEdge(ring, spec.siteEdge)
  if (!se) return null
  const dx = se.b.e - se.a.e
  const dy = se.b.n - se.a.n
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null

  const sign = spec.fromEnd ? -1 : 1
  const ux = (dx / len) * sign
  const uy = (dy / len) * sign
  const base = spec.fromEnd ? se.b : se.a
  const inward = isCcw(ring) ? { e: -dy / len, n: dx / len } : { e: dy / len, n: -dx / len }

  const alongEnd = { e: base.e + ux * spec.along, n: base.n + uy * spec.along }
  return {
    base,
    alongEnd,
    target: {
      e: alongEnd.e + inward.e * spec.offset,
      n: alongEnd.n + inward.n * spec.offset,
    },
  }
}

/**
 * 建物 の 1 辺 を 境界線 に 平行 に して 据える。
 * 離れ (offset) と 沿い (along) で 残り の 2 つ の 自由度 を 決める。
 */
export function solveByParallel(
  moves: Move[],
  ring: EN[],
  spec: ParallelSpec,
): Placement | null {
  const pts = outlineFromMoves(moves)
  const bm = moves[spec.buildingEdge]
  const se = siteEdge(ring, spec.siteEdge)
  if (!bm || !se || pts.length < 2) return null

  const bLen = Math.hypot(bm.h, bm.v)
  const sdx = se.b.e - se.a.e
  const sdy = se.b.n - se.a.n
  const sLen = Math.hypot(sdx, sdy)
  if (bLen < 1e-9 || sLen < 1e-9) return null

  // 基点 を 終点 側 に した ら 進む 向き も 逆 に する
  const sign = spec.fromEnd ? -1 : 1
  let theta = Math.atan2(sdy * sign, sdx * sign) - Math.atan2(bm.v, bm.h)
  if (spec.flip) theta += Math.PI

  const g = parallelGuides(ring, spec)
  if (!g) return null
  const target = g.target

  const p0 = pts[spec.buildingEdge] ?? { x: 0, y: 0 }
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return {
    offsetE: round3(target.e - (p0.x * cos - p0.y * sin)),
    offsetN: round3(target.n - (p0.x * sin + p0.y * cos)),
    rotationDeg: round4((((theta * 180) / Math.PI) % 360 + 360) % 360),
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
const round4 = (v: number) => Math.round(v * 10000) / 10000
