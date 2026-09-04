// LandXML TIN Surface を Leaflet 上に 描画 する 用 の レンダデータ に 変換する。
// 生成物:
//   - triangles:  色分けメッシュ (Polygon) 用。 各三角形 の 3 頂点 LatLng + 平均標高 zAvg
//   - edges:      ワイヤーフレーム (Polyline) 用。 重複除去 された 無向辺
//   - contours:   等高線 (Polyline) 用。 marching triangles で 各高さ z の セグメント
//
// 座標変換 は CoordinateConverter (JGD 平面直角 → LatLng) に 依存。
// 標高 → 色 の マッピング は hypsometricColor で 別に 提供。

import type { ParsedSurface } from './parser'
import type { CoordinateConverter } from '../coordinates'

export interface RenderedTriangle {
  positions: [[number, number], [number, number], [number, number]]
  zAvg: number
}

export interface RenderedEdge {
  positions: [[number, number], [number, number]]
}

export interface RenderedContour {
  /** 標高 (m) */
  z: number
  /** 各 三角形 内 の 交線 セグメント。 1 セグメント = 2 点。 */
  segments: [[number, number], [number, number]][]
}

export interface RenderedTin {
  zMin: number
  zMax: number
  triangles: RenderedTriangle[]
  edges: RenderedEdge[]
  contours: RenderedContour[]
  /** 自動選定 された 等高線 間隔 (m)。 UI 表示用。 */
  contourInterval: number
}

/**
 * TIN Surface を レンダデータ に 変換。
 * @param contourInterval  等高線 間隔 (m)。 undefined で 標高レンジ から 自動 (0.05/0.1/0.2/0.5/1/2/5/10/20/50/100 の 中 から 選定)
 */
export function renderTin(
  surface: ParsedSurface,
  converter: CoordinateConverter,
  contourInterval?: number,
): RenderedTin {
  // 全頂点 を LatLng 化 (キャッシュ)。 NaN は 「無効」マーカー
  const ll: [number, number][] = []
  for (const p of surface.points) {
    try {
      const { lat, lng } = converter.toLatLng(p.x, p.y)
      if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
      else ll.push([Number.NaN, Number.NaN])
    } catch {
      ll.push([Number.NaN, Number.NaN])
    }
  }

  let zMin = Number.POSITIVE_INFINITY
  let zMax = Number.NEGATIVE_INFINITY
  for (const p of surface.points) {
    if (Number.isFinite(p.z)) {
      if (p.z < zMin) zMin = p.z
      if (p.z > zMax) zMax = p.z
    }
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return {
      zMin: 0,
      zMax: 0,
      triangles: [],
      edges: [],
      contours: [],
      contourInterval: 1,
    }
  }

  // 三角形 (色分けメッシュ)
  const triangles: RenderedTriangle[] = []
  for (const t of surface.triangles) {
    const a = ll[t.a]
    const b = ll[t.b]
    const c = ll[t.c]
    if (!a || !b || !c) continue
    if (!Number.isFinite(a[0]) || !Number.isFinite(b[0]) || !Number.isFinite(c[0])) continue
    const pa = surface.points[t.a]
    const pb = surface.points[t.b]
    const pc = surface.points[t.c]
    if (!pa || !pb || !pc) continue
    triangles.push({
      positions: [a, b, c],
      zAvg: (pa.z + pb.z + pc.z) / 3,
    })
  }

  // 辺 (ワイヤーフレーム) — 重複除去 (無向辺)
  const edgeSet = new Set<string>()
  const edges: RenderedEdge[] = []
  const addEdge = (i: number, j: number) => {
    const key = i < j ? `${i}_${j}` : `${j}_${i}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    const a = ll[i]
    const b = ll[j]
    if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(b[0])) return
    edges.push({ positions: [a, b] })
  }
  for (const t of surface.triangles) {
    addEdge(t.a, t.b)
    addEdge(t.b, t.c)
    addEdge(t.c, t.a)
  }

  // 等高線 (marching triangles)
  const interval = contourInterval ?? autoInterval(zMax - zMin)
  const contours: RenderedContour[] = []
  const zStart = Math.ceil(zMin / interval) * interval
  const zEnd = Math.floor(zMax / interval) * interval
  for (let z = zStart; z <= zEnd + 1e-6; z += interval) {
    const segs: [[number, number], [number, number]][] = []
    for (const t of surface.triangles) {
      const pa = surface.points[t.a]
      const pb = surface.points[t.b]
      const pc = surface.points[t.c]
      if (!pa || !pb || !pc) continue
      // 交差 する 辺 を 見つける (符号 が 異なる 頂点 の ペア)
      const eds: [number, number][] = [
        [t.a, t.b],
        [t.b, t.c],
        [t.c, t.a],
      ]
      const hits: [number, number][] = []
      for (const [i, j] of eds) {
        const zi = surface.points[i].z
        const zj = surface.points[j].z
        if (!Number.isFinite(zi) || !Number.isFinite(zj)) continue
        if ((zi - z) * (zj - z) < 0) {
          const tParam = (z - zi) / (zj - zi)
          const ai = ll[i]
          const aj = ll[j]
          if (!ai || !aj || !Number.isFinite(ai[0]) || !Number.isFinite(aj[0])) continue
          const lat = ai[0] + (aj[0] - ai[0]) * tParam
          const lng = ai[1] + (aj[1] - ai[1]) * tParam
          hits.push([lat, lng])
        }
      }
      if (hits.length === 2) segs.push([hits[0], hits[1]])
    }
    if (segs.length > 0) {
      contours.push({ z: Math.round(z * 1000) / 1000, segments: segs })
    }
  }

  return { zMin, zMax, triangles, edges, contours, contourInterval: interval }
}

/**
 * 標高レンジ から 「見やすい」等高線 間隔 を 自動選定。
 * 目安: ~20 本 くらい の 等高線 が 引ける 数値 を 1/2/5 系列 で 丸める。
 */
export function autoInterval(range: number): number {
  if (!Number.isFinite(range) || range <= 0) return 1
  const raw = range / 20
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
  for (const s of steps) if (raw < s * 1.5) return s
  return 100
}

/**
 * 標高 z を hypsometric カラー (HSL 青 → 緑 → 黄 → 赤) に 変換。
 * zMin=zMax の 場合 は 中央 (緑) を 返す。
 */
export function hypsometricColor(z: number, zMin: number, zMax: number): string {
  const range = zMax - zMin
  const t = range < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (z - zMin) / range))
  // 240 (青) → 0 (赤)
  const hue = 240 - 240 * t
  return `hsl(${hue.toFixed(0)}, 70%, 55%)`
}
