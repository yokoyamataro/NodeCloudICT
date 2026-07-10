// GeoJSON FeatureCollection を Web Mercator XYZ タイルに分割する。
//
// 各 Feature の bbox が跨るタイル全てに複製で入れる (クリッピングはしない)。
// 取込時はクライアントで parcel_number を鍵に重複排除するので、境界を跨ぐ
// feature が 2 度描画されるだけ。

import type { FeatureCollection, Feature, Polygon } from 'geojson'
import type { ParcelFeatureProperties } from './jpgis-to-geojson'
import {
  bboxToTiles,
  lngLatToTile,
  ringBbox,
  tileKey,
  type TileCoord,
} from './tile-math'

export interface TileIndex {
  /** タイル分割時のズームレベル */
  zoom: number
  /** データセット全体の bbox */
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }
  /** feature が 1 件以上入っているタイルのキー ('z/x/y') と件数 */
  tiles: Array<{ z: number; x: number; y: number; count: number }>
}

export interface TilingResult {
  /** タイル毎の FeatureCollection */
  tiles: Map<string, FeatureCollection<Polygon, ParcelFeatureProperties>>
  index: TileIndex
}

/**
 * FeatureCollection を tile ごとの Map に分割する。
 *
 * @param fc     元 FeatureCollection (WGS84 経緯度)
 * @param zoom   タイルズームレベル (推奨 13-15)
 */
export function tileFeatureCollection(
  fc: FeatureCollection<Polygon, ParcelFeatureProperties>,
  zoom: number,
): TilingResult {
  const tiles = new Map<string, Feature<Polygon, ParcelFeatureProperties>[]>()
  let globalMinLng = Infinity
  let globalMinLat = Infinity
  let globalMaxLng = -Infinity
  let globalMaxLat = -Infinity

  for (const feature of fc.features) {
    const outer = feature.geometry.coordinates[0] as Array<[number, number]>
    if (!outer || outer.length === 0) continue
    const bb = ringBbox(outer)
    if (bb.minLng < globalMinLng) globalMinLng = bb.minLng
    if (bb.minLat < globalMinLat) globalMinLat = bb.minLat
    if (bb.maxLng > globalMaxLng) globalMaxLng = bb.maxLng
    if (bb.maxLat > globalMaxLat) globalMaxLat = bb.maxLat

    // 通常サイズの筆は 1-2 タイル。大きな道路等は 3-4 タイルまたがる。
    // 巨大な feature (例: 全町を通る道路) は 10 タイル以上跨ぐこともあるので、
    // ここでは bboxToTiles の展開に制限を付けない (現実的な地番データは
    // 数タイル以内に収まる想定)。
    const covered = bboxToTiles(bb, zoom)
    for (const tc of covered) {
      const key = tileKey(tc)
      let bucket = tiles.get(key)
      if (!bucket) {
        bucket = []
        tiles.set(key, bucket)
      }
      bucket.push(feature)
    }
  }

  const outputTiles = new Map<
    string,
    FeatureCollection<Polygon, ParcelFeatureProperties>
  >()
  const indexEntries: Array<{ z: number; x: number; y: number; count: number }> = []
  for (const [key, features] of tiles.entries()) {
    outputTiles.set(key, {
      type: 'FeatureCollection',
      features,
    })
    const [z, x, y] = key.split('/').map((n) => parseInt(n, 10))
    indexEntries.push({ z, x, y, count: features.length })
  }

  const index: TileIndex = {
    zoom,
    bbox: {
      minLng: Number.isFinite(globalMinLng) ? globalMinLng : 0,
      minLat: Number.isFinite(globalMinLat) ? globalMinLat : 0,
      maxLng: Number.isFinite(globalMaxLng) ? globalMaxLng : 0,
      maxLat: Number.isFinite(globalMaxLat) ? globalMaxLat : 0,
    },
    tiles: indexEntries,
  }

  return { tiles: outputTiles, index }
}

/**
 * 複数の FeatureCollection を parcel_number で重複排除して 1 つに統合する。
 * タイル境界にまたがる feature が複数タイルにコピーされているため、client 側で
 * まとめて描画するときにこれを呼ぶ。
 */
export function mergeAndDedup(
  fcs: FeatureCollection<Polygon, ParcelFeatureProperties>[],
): FeatureCollection<Polygon, ParcelFeatureProperties> {
  const seen = new Set<string>()
  const features: Feature<Polygon, ParcelFeatureProperties>[] = []
  for (const fc of fcs) {
    for (const f of fc.features) {
      const key = f.properties.parcel_number || `${f.properties.parcel_name}`
      if (seen.has(key)) continue
      seen.add(key)
      features.push(f)
    }
  }
  return { type: 'FeatureCollection', features }
}

/** タイルを z=15 単位でグループ化するため、feature 中心 lng/lat から所属タイルを返す */
export function centroidTile(
  feature: Feature<Polygon, ParcelFeatureProperties>,
  zoom: number,
): TileCoord | null {
  const outer = feature.geometry.coordinates[0] as Array<[number, number]>
  if (!outer || outer.length === 0) return null
  const bb = ringBbox(outer)
  const cx = (bb.minLng + bb.maxLng) / 2
  const cy = (bb.minLat + bb.maxLat) / 2
  return lngLatToTile(cx, cy, zoom)
}
