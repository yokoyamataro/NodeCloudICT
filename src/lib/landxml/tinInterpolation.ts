// LandXML の TIN サーフェスから任意点の Z（標高）を補間するヘルパー
//
// 使い方：
//   const result = parseLandXml(xmlText)
//   const surf = result.surfaces[0]
//   const z = interpolateZOnTin(surf, x, y)
//
// 大量点を扱う場合は indexTin で前処理してから queryZ を呼ぶと
// 三角形バウンディングボックスでの早期枝刈りが効く。

import { parseLandXml, type ParsedSurface } from './parser'

export interface TinIndex {
  surface: ParsedSurface
  bounds: { minX: number; maxX: number; minY: number; maxY: number }[]
}

const EPS = 1e-9

/**
 * 三角形バウンディングボックスを事前計算
 */
export function indexTin(surface: ParsedSurface): TinIndex {
  const bounds: TinIndex['bounds'] = []
  for (const tri of surface.triangles) {
    const a = surface.points[tri.a]
    const b = surface.points[tri.b]
    const c = surface.points[tri.c]
    if (!a || !b || !c) {
      bounds.push({ minX: 0, maxX: -1, minY: 0, maxY: -1 })
      continue
    }
    const minX = Math.min(a.x, b.x, c.x)
    const maxX = Math.max(a.x, b.x, c.x)
    const minY = Math.min(a.y, b.y, c.y)
    const maxY = Math.max(a.y, b.y, c.y)
    bounds.push({ minX, maxX, minY, maxY })
  }
  return { surface, bounds }
}

/**
 * 指定点 (x, y) が含まれる三角形を線形探索し、重心座標で Z を補間。
 * 含まれる三角形がなければ null。
 */
export function queryZ(idx: TinIndex, x: number, y: number): number | null {
  const { surface, bounds } = idx
  const tris = surface.triangles
  for (let i = 0; i < tris.length; i++) {
    const bb = bounds[i]
    if (x < bb.minX - EPS || x > bb.maxX + EPS || y < bb.minY - EPS || y > bb.maxY + EPS) continue
    const tri = tris[i]
    const a = surface.points[tri.a]
    const b = surface.points[tri.b]
    const c = surface.points[tri.c]
    if (!a || !b || !c) continue
    const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
    if (Math.abs(denom) < EPS) continue
    const w1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denom
    const w2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denom
    const w3 = 1 - w1 - w2
    // 三角形内部（境界含む。EPS 緩和あり）
    if (w1 >= -EPS && w2 >= -EPS && w3 >= -EPS) {
      return w1 * a.z + w2 * b.z + w3 * c.z
    }
  }
  return null
}

/**
 * 簡易ラッパ（少数点向け）。事前 index しないバージョン。
 */
export function interpolateZOnTin(
  surface: ParsedSurface,
  x: number,
  y: number,
): number | null {
  return queryZ(indexTin(surface), x, y)
}

/**
 * ファイルから LandXML を読み込んでパース
 */
export async function loadLandXmlFile(
  file: File,
): Promise<{ surfaces: ParsedSurface[]; warnings: string[] }> {
  const text = await file.text()
  const result = parseLandXml(text, file.name)
  return { surfaces: result.surfaces, warnings: result.warnings }
}
