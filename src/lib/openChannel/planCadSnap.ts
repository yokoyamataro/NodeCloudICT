// 背景 CAD の 線群 に 対する スナップ。 地図 で 「CAD の 端 に 寄せて 拾う」
// 用途 で 使う。 整地 の 任意測点 取得 と 全体図 の 座標 追加 で 共有。
//
// 優先 順位 (上 が 強い):
//   1. 端点 (polyline の 両端) — もっとも 特徴 的
//   2. 交点 (2 本 の 線 が 交わる 所)
//   3. 中間 頂点 (折れ点)
//   4. 辺 上 (垂線 の 足)
// 上位 tier に 候補 が あれば tier 内 の 最短 を 使う。 下位 tier は 見 な い。
// 端点 と 交点 は 同じ tier で 距離 比較 する ため、 ユーザ が どちら に 近く
// 押した か が 素直 に 反映 される。

export type SnapKind = 'endpoint' | 'intersection' | 'vertex' | 'edge'

/** 近傍 判定 の 上限。 ≈ 22m 相当。 引き 過ぎ で 誤爆 させ ない ため。 */
const SNAP_DEG = 0.0002

/**
 * lat/lng を CAD の 折れ線 群 に 対して スナップ する。
 * 近傍 に 何 も 無ければ null。
 */
export function snapLatLngToCadLines(
  lat: number,
  lng: number,
  polylines: { pts: [number, number][] }[],
): { lat: number; lng: number; kind: SnapKind } | null {
  const kx = Math.cos((lat * Math.PI) / 180)
  const tol = SNAP_DEG
  const tol2 = tol * tol
  type Cand = { lat: number; lng: number; d2: number }
  const endpoints: Cand[] = []
  const vertices: Cand[] = []
  const edges: Cand[] = []
  type Seg = { alat: number; alng: number; blat: number; blng: number }
  const nearSegs: Seg[] = []

  const d2Of = (plat: number, plng: number) => {
    const dy = plat - lat
    const dx = (plng - lng) * kx
    return dx * dx + dy * dy
  }

  for (const line of polylines) {
    const pts = line.pts
    const n = pts.length
    if (n < 1) continue
    for (let i = 0; i < n; i++) {
      const [alat, alng] = pts[i]
      const d2 = d2Of(alat, alng)
      if (d2 < tol2) {
        const isEndpoint = i === 0 || i === n - 1
        ;(isEndpoint ? endpoints : vertices).push({ lat: alat, lng: alng, d2 })
      }
      if (i + 1 >= n) continue
      const [blat, blng] = pts[i + 1]
      const minLat = Math.min(alat, blat) - tol
      const maxLat = Math.max(alat, blat) + tol
      const minLng = Math.min(alng, blng) - tol / kx
      const maxLng = Math.max(alng, blng) + tol / kx
      if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue
      nearSegs.push({ alat, alng, blat, blng })
      const eyLat = blat - alat
      const eyLng = (blng - alng) * kx
      const den = eyLat * eyLat + eyLng * eyLng
      if (den <= 0) continue
      const dyLat = lat - alat
      const dyLng = (lng - alng) * kx
      const t = (dyLat * eyLat + dyLng * eyLng) / den
      if (t <= 0 || t >= 1) continue
      const plat = alat + t * (blat - alat)
      const plng = alng + t * (blng - alng)
      const dEdge2 = d2Of(plat, plng)
      if (dEdge2 < tol2) edges.push({ lat: plat, lng: plng, d2: dEdge2 })
    }
  }

  // 交点 (2 本 の 辺 の 交わり) を 近傍 の 辺 の 組合せ から 計算
  const intersections: Cand[] = []
  for (let i = 0; i < nearSegs.length; i++) {
    const s1 = nearSegs[i]
    for (let j = i + 1; j < nearSegs.length; j++) {
      const s2 = nearSegs[j]
      const p = segSegIntersect(s1, s2, kx)
      if (!p) continue
      const d2 = d2Of(p.lat, p.lng)
      if (d2 < tol2) intersections.push({ lat: p.lat, lng: p.lng, d2 })
    }
  }

  const pickBestKind = (
    arrs: { arr: Cand[]; kind: SnapKind }[],
  ): { c: Cand; kind: SnapKind } | null => {
    let best: { c: Cand; kind: SnapKind } | null = null
    for (const { arr, kind } of arrs) {
      for (const c of arr) {
        if (!best || c.d2 < best.c.d2) best = { c, kind }
      }
    }
    return best
  }
  const feature = pickBestKind([
    { arr: endpoints, kind: 'endpoint' },
    { arr: intersections, kind: 'intersection' },
  ])
  if (feature) return { lat: feature.c.lat, lng: feature.c.lng, kind: feature.kind }
  const line = pickBestKind([
    { arr: vertices, kind: 'vertex' },
    { arr: edges, kind: 'edge' },
  ])
  if (line) return { lat: line.c.lat, lng: line.c.lng, kind: line.kind }
  return null
}

/**
 * 2 辺 の 交点。 両 辺 の 内側 で 交わる とき だけ 返す。
 * kx は 緯度線 に 沿った 縮尺補正 (近似 平坦)。
 */
function segSegIntersect(
  s1: { alat: number; alng: number; blat: number; blng: number },
  s2: { alat: number; alng: number; blat: number; blng: number },
  kx: number,
): { lat: number; lng: number } | null {
  const x1 = s1.alng * kx
  const y1 = s1.alat
  const x2 = s1.blng * kx
  const y2 = s1.blat
  const x3 = s2.alng * kx
  const y3 = s2.alat
  const x4 = s2.blng * kx
  const y4 = s2.blat
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(den) < 1e-18) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  const plat = y1 + t * (y2 - y1)
  const plng = (x1 + t * (x2 - x1)) / kx
  return { lat: plat, lng: plng }
}
