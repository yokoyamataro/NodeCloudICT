// 隣接地 の ヒゲ線 と 地番。
//
// 建物図面 で は、敷地 に 接する 土地 の 境界線 を 敷地 の 外側 へ 少し だけ
// 伸ばして 描き (ヒゲ線)、その 土地 の 地番 を 添える。 どこ が どの 土地 と
// 接して いる か を 示す ため。
//
// 隣接 して いる か の 判定: 隣接地 の 節点 が **敷地 の 境界 (節点 or 辺) に
// 近い** か で 見る。 辺 まで を 対象 に する の は、 申請地 が 確定 境界 で
// 隣接地 が 仮 境界 の 時 の よう に、 同じ 境界 でも 節点 の 座標 が 少し
// ずれて いる (= 現地座標 は 一致 しない) ケース を 救う ため。
//
// 伸ばす 長さ は 用紙 の 上 で 決める (既定 10mm)。 1/500 なら 現地 5m。

import type { EN } from './floorPlanPlace'

export interface WhiskerParcel {
  label: string
  /** 平面直角座標 の 構成点 (X=北 / Y=東) */
  points: { x: number; y: number }[]
}

export interface WhiskerResult {
  /** 敷地 の 外 へ 伸ばす 線 (現地座標) */
  stubs: { a: EN; b: EN }[]
  /** 隣接地 の 地番 を 置く 位置 */
  labels: { at: EN; text: string }[]
}

/** 「敷地 と 共有 して いる」 と 見なす 現地 距離 (m)。
 *  旧 実装 は 0.02m (2cm) で 節点 の 完全 一致 だけ だった が、
 *  確定 / 仮 の 混在 で 10cm 単位 の ズレ が 出る ため 0.5m に 緩める。 */
const SNAP = 0.5

const toEN = (p: { x: number; y: number }): EN => ({ e: p.y, n: p.x })

/** 点 p と 線分 a-b の 距離 (m)。 線分 の 外側 の 場合 は 端点 まで の 距離。 */
function distPointSegment(p: EN, a: EN, b: EN): number {
  const dx = b.e - a.e
  const dn = b.n - a.n
  const len2 = dx * dx + dn * dn
  if (len2 < 1e-12) return Math.hypot(p.e - a.e, p.n - a.n)
  let t = ((p.e - a.e) * dx + (p.n - a.n) * dn) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const qx = a.e + dx * t
  const qn = a.n + dn * t
  return Math.hypot(p.e - qx, p.n - qn)
}

function centroid(pts: EN[]): EN {
  if (pts.length === 0) return { e: 0, n: 0 }
  return {
    e: pts.reduce((s, p) => s + p.e, 0) / pts.length,
    n: pts.reduce((s, p) => s + p.n, 0) / pts.length,
  }
}

/**
 * 敷地 に 接する 土地 の ヒゲ線 と 地番 の 位置 を 作る。
 *
 * lengthM … 敷地 の 外 へ 伸ばす 長さ (現地 の m)。 辺 が それ より 短い
 *           ときは 辺 の 長さ まで。
 */
export function buildWhiskers(
  site: WhiskerParcel[],
  others: WhiskerParcel[],
  lengthM: number,
): WhiskerResult {
  const sitePts: EN[] = site.flatMap((p) => p.points.map(toEN))
  if (sitePts.length === 0 || lengthM <= 0) return { stubs: [], labels: [] }

  // 敷地 の 辺 (閉じた 多角形 と して 隣接する 2 点 を つなぐ 線分 列)
  const siteSegs: Array<{ a: EN; b: EN }> = []
  for (const parcel of site) {
    const ring = parcel.points.map(toEN)
    for (let i = 0; i < ring.length; i += 1) {
      siteSegs.push({ a: ring[i], b: ring[(i + 1) % ring.length] })
    }
  }

  // 点 が 「敷地 と 共有 する 位置 に ある」 か。 節点 一致 だけ で なく、
  // 敷地 の 辺 上 の 近傍 も 含める (確定 と 仮 で 節点 が ずれて いる 場合 の 救済)。
  const onSite = (p: EN): boolean => {
    for (const q of sitePts) {
      if (Math.hypot(p.e - q.e, p.n - q.n) < SNAP) return true
    }
    for (const s of siteSegs) {
      if (distPointSegment(p, s.a, s.b) < SNAP) return true
    }
    return false
  }

  const stubs: WhiskerResult['stubs'] = []
  const labels: WhiskerResult['labels'] = []
  const drawn = new Set<string>()

  for (const other of others) {
    const ring = other.points.map(toEN)
    if (ring.length < 2) continue

    const shared = ring.filter(onSite)
    // 節点 を 共有 して いなければ 隣接 して いない
    if (shared.length === 0) continue

    const c = centroid(ring)

    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const sa = onSite(a)
      const sb = onSite(b)
      // 両端 とも 敷地 の 節点 = 敷地 と の 共有辺。 既に 敷地 の 外形 で 描いて いる
      if (sa === sb) continue

      const from = sa ? a : b
      const to = sa ? b : a
      const len = Math.hypot(to.e - from.e, to.n - from.n)
      if (len < 1e-6) continue
      const t = Math.min(lengthM, len) / len
      const end: EN = { e: from.e + (to.e - from.e) * t, n: from.n + (to.n - from.n) * t }

      // 同じ 線 を 2 度 引かない (隣 どうし が 同じ 辺 を 持つ こと が ある)
      const k = [from.e, from.n, end.e, end.n].map((v) => v.toFixed(3)).join(',')
      if (drawn.has(k)) continue
      drawn.add(k)
      stubs.push({ a: from, b: end })
    }

    // 地番 は 共有 した ところ から 隣接地 の 側 へ 寄せて 置く
    const base = centroid(shared)
    const dx = c.e - base.e
    const dy = c.n - base.n
    const d = Math.hypot(dx, dy)
    const push = lengthM * 0.7
    labels.push({
      at:
        d < 1e-6
          ? base
          : { e: base.e + (dx / d) * push, n: base.n + (dy / d) * push },
      text: other.label,
    })
  }

  return { stubs, labels }
}
