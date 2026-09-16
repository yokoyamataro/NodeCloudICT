// 求積 の 区分。
//
// 建物 の 形 を 長方形 / 台形 / 三角形 に 分け、それぞれ に イ・ロ・ハ… を
// 振る。 求積表 の 各行 が 図 の どの 部分 か を 示す ため。
//
// 分け方 は 2 通り:
//   * 区切り線 … 頂点 と 頂点 を 結ぶ 線 で 切る。 手 で 決める
//   * 自動     … 頂点 の 高さ で 横 に 切り、上下 2 辺 が 平行 な 帯 に する。
//                 どんな 形 でも 台形 の 足し算 に なる ので 必ず 割り切れる
//
// 区分 の 境目 は 図面 では 一点鎖線 で 描く。

import { newId, type AreaTerm, type Pt, type TermKind } from './floorPlanTypes'

/** 区切り線。 外形 の 頂点 番号 を 2 つ 結ぶ */
export interface AreaCut {
  id: string
  a: number
  b: number
}

/** 分けた 1 区画 */
export interface AreaRegion {
  id: string
  pts: Pt[]
}

/** 求積 の 記号。 イロハ順 */
const KANA = [
  'イ', 'ロ', 'ハ', 'ニ', 'ホ', 'ヘ', 'ト', 'チ', 'リ', 'ヌ', 'ル', 'ヲ',
  'ワ', 'カ', 'ヨ', 'タ', 'レ', 'ソ', 'ツ', 'ネ', 'ナ', 'ラ', 'ム', 'ウ',
]
export const regionLabel = (i: number): string => KANA[i] ?? String(i + 1)

const EPS = 1e-7

export function polyArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let s = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export function polyCentroid(pts: Pt[]): Pt {
  if (pts.length === 0) return { x: 0, y: 0 }
  let cx = 0
  let cy = 0
  let a = 0
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    const f = p.x * q.y - q.x * p.y
    a += f
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  if (Math.abs(a) < EPS) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
  }
  return { x: cx / (3 * a), y: cy / (3 * a) }
}

function inside(pts: Pt[], p: Pt): boolean {
  let on = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      on = !on
    }
  }
  return on
}

// ========================================================================
// 区切り線 で 分ける
// ========================================================================

/**
 * 頂点 と 頂点 を 結ぶ 線 で 順 に 切る。
 * 切る 線 が 外 を 通って いる とき は 無視 する (形 が 壊れない ように)。
 */
export function splitByCuts(outline: Pt[], cuts: AreaCut[]): AreaRegion[] {
  if (outline.length < 3) return []
  let rings: number[][] = [outline.map((_, i) => i)]

  for (const cut of cuts) {
    if (cut.a === cut.b) continue
    const idx = rings.findIndex((r) => r.includes(cut.a) && r.includes(cut.b))
    if (idx < 0) continue
    const r = rings[idx]
    const ia = r.indexOf(cut.a)
    const ib = r.indexOf(cut.b)
    const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia]
    if (hi - lo < 2 && r.length - (hi - lo) < 2) continue
    const p1 = r.slice(lo, hi + 1)
    const p2 = [...r.slice(hi), ...r.slice(0, lo + 1)]
    if (p1.length < 3 || p2.length < 3) continue
    // 切る 線 が 区画 の 中 を 通って いる か
    const mid = {
      x: (outline[cut.a].x + outline[cut.b].x) / 2,
      y: (outline[cut.a].y + outline[cut.b].y) / 2,
    }
    if (!inside(r.map((i) => outline[i]), mid)) continue
    rings = [...rings.slice(0, idx), p1, p2, ...rings.slice(idx + 1)]
  }

  return rings.map((r) => ({ id: newId(), pts: r.map((i) => outline[i]) }))
}

// ========================================================================
// 自動 (横 に 切って 台形 の 足し算 に する)
// ========================================================================

/**
 * 頂点 の 高さ ごと に 横 に 切る。
 *
 * 帯 の 中 では 形 が 変わらない ので、帯 を 貫く 辺 だけ を 見れば よい。
 * その 辺 の 上 で 上端 と 下端 の x を 補間 すれば、帯 は 上下 が 平行 な
 * 四角形 (= 台形) に なる。 斜め の 隅切り が あって も そのまま 扱える。
 *
 * 断面 を 「その 高さ で 切る」 で 求める と、帯 の 境目 が 頂点 と 重なった
 * ときに 数 が 合わなく なる。 辺 から 直接 補間 する のは その ため。
 */
export function autoSlabs(outline: Pt[]): AreaRegion[] {
  if (outline.length < 3) return []
  const ys = Array.from(new Set(outline.map((p) => Math.round(p.y * 1e6) / 1e6))).sort(
    (a, b) => a - b,
  )

  const out: AreaRegion[] = []
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i]
    const y1 = ys[i + 1]
    if (y1 - y0 < 1e-6) continue
    const mid = (y0 + y1) / 2

    // 帯 を 貫く 辺 を 拾い、上端 / 下端 の x を 出す
    const cols: { x0: number; x1: number; xm: number }[] = []
    for (let k = 0; k < outline.length; k += 1) {
      const a = outline[k]
      const b = outline[(k + 1) % outline.length]
      const lo = Math.min(a.y, b.y)
      const hi = Math.max(a.y, b.y)
      if (hi - lo < 1e-9) continue
      if (lo > mid || hi < mid) continue
      const xAt = (y: number) => a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y)
      cols.push({ x0: xAt(y0), x1: xAt(y1), xm: xAt(mid) })
    }
    cols.sort((p, q) => p.xm - q.xm)

    // 左 から 2 本 ずつ が 1 区画
    for (let k = 0; k + 1 < cols.length; k += 2) {
      const l = cols[k]
      const r = cols[k + 1]
      const pts: Pt[] = [
        { x: l.x0, y: y0 },
        { x: r.x0, y: y0 },
        { x: r.x1, y: y1 },
        { x: l.x1, y: y1 },
      ]
      // 上下 どちら か が 潰れて いる ときは 三角形 に する
      const uniq = pts.filter(
        (p, n) => n === 0 || Math.hypot(p.x - pts[n - 1].x, p.y - pts[n - 1].y) > 1e-9,
      )
      const ring =
        uniq.length >= 3 &&
        Math.hypot(uniq[0].x - uniq[uniq.length - 1].x, uniq[0].y - uniq[uniq.length - 1].y) < 1e-9
          ? uniq.slice(0, -1)
          : uniq
      if (ring.length < 3 || polyArea(ring) < 1e-6) continue
      out.push({ id: newId(), pts: ring })
    }
  }
  return out
}

// ========================================================================
// 区画 を 求積 の 式 に する
// ========================================================================

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** 点 p から 直線 ab まで の 距離 */
function lineDist(a: Pt, b: Pt, p: Pt): number {
  const L = dist(a, b)
  if (L < EPS) return dist(a, p)
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L
}

/** 2 辺 が 平行 か */
function parallel(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  const scale = dist(a, b) * dist(c, d)
  return scale > EPS && Math.abs(cross) / scale < 1e-4
}

/**
 * 区画 の 形 を 見て 求積 の 式 を 決める。
 * 長方形 / 台形 / 三角形 の どれ でも ない 形 は、座標法 の 面積 を
 * そのまま 書く (自由入力)。
 */
export function classifyRegion(pts: Pt[]): {
  kind: TermKind
  a: number
  b: number
  h: number
  manual: number
  note: string
} {
  const area = polyArea(pts)
  const r3 = (v: number) => Math.round(v * 1000) / 1000

  if (pts.length === 3) {
    // 一番 長い 辺 を 底辺 に する
    let bi = 0
    let bl = 0
    for (let i = 0; i < 3; i += 1) {
      const L = dist(pts[i], pts[(i + 1) % 3])
      if (L > bl) {
        bl = L
        bi = i
      }
    }
    const a = pts[bi]
    const b = pts[(bi + 1) % 3]
    const c = pts[(bi + 2) % 3]
    return { kind: 'triangle', a: r3(bl), b: r3(lineDist(a, b, c)), h: 0, manual: 0, note: '' }
  }

  if (pts.length === 4) {
    const [p0, p1, p2, p3] = pts
    const s = [dist(p0, p1), dist(p1, p2), dist(p2, p3), dist(p3, p0)]
    // 長方形: 向かい合う 辺 が 等しく、角 が 直角
    const rightAngle = (a: Pt, b: Pt, c: Pt) => {
      const ux = a.x - b.x
      const uy = a.y - b.y
      const vx = c.x - b.x
      const vy = c.y - b.y
      const L = Math.hypot(ux, uy) * Math.hypot(vx, vy)
      return L > EPS && Math.abs(ux * vx + uy * vy) / L < 1e-4
    }
    if (
      rightAngle(p3, p0, p1) &&
      rightAngle(p0, p1, p2) &&
      rightAngle(p1, p2, p3) &&
      Math.abs(s[0] - s[2]) < 1e-4
    ) {
      return { kind: 'rect', a: r3(s[0]), b: r3(s[1]), h: 0, manual: 0, note: '' }
    }
    // 台形: 平行 な 1 組 を 上底 / 下底 に する
    for (const [i, j] of [
      [0, 2],
      [1, 3],
    ]) {
      const a1 = pts[i]
      const a2 = pts[(i + 1) % 4]
      const b1 = pts[j]
      const b2 = pts[(j + 1) % 4]
      if (parallel(a1, a2, b1, b2)) {
        const h = (lineDist(a1, a2, b1) + lineDist(a1, a2, b2)) / 2
        return {
          kind: 'trapezoid',
          a: r3(dist(a1, a2)),
          b: r3(dist(b1, b2)),
          h: r3(h),
          manual: 0,
          note: '',
        }
      }
    }
  }

  return {
    kind: 'manual',
    a: 0,
    b: 0,
    h: 0,
    manual: Math.round(area * 1e6) / 1e6,
    note: '座標法',
  }
}

/** 区画 の 並び を 求積表 の 行 に する */
export function termsFromRegions(regions: AreaRegion[]): AreaTerm[] {
  return regions.map((r, i) => ({
    id: r.id,
    ...classifyRegion(r.pts),
    label: regionLabel(i),
    region: r.pts,
  }))
}
