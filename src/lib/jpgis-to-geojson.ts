// JPGIS (JSIMA) パース結果を GeoJSON FeatureCollection に変換する。
//
// なぜ GeoJSON:
//   * Leaflet の <GeoJSON> でそのまま描画できる (WGS84 前提)
//   * PMTiles 化する前段としても互換性がある
//
// properties の設計:
//   parcel_number / parcel_name / owner_name / registered_area_sqm を平文で入れつつ、
//   工区取込 (WGS84 → JPRC で再変換) の精度劣化を避けるため、原座標 (JPRC x,y) を
//   閉じた頂点配列としてそのまま保持する (jprc_coords)。取込時は zone 一致なら
//   jprc_coords をそのまま使い、異ゾーンなら緯度経度から現ゾーンに再投影する。

import type { FeatureCollection, Feature, Polygon } from 'geojson'
import type { JpgisParseResult } from './jpgis-parser'
import { CoordinateConverter } from './coordinates'

export interface ParcelFeatureProperties {
  parcel_number: string
  parcel_name: string
  owner_name: string | null
  registered_area_sqm: number | null
  /** 原 JPRC 座標系での頂点 (x, y) の順序付きリスト。閉じた多角形として polygon
   *  外周の順に並ぶ。取込時にゾーン一致していればそのまま使う。 */
  jprc_coords: Array<[number, number]>
  /** ソースデータの JPRC 系番号 (1-19) */
  source_zone: number
}

export interface JpgisToGeoJsonResult {
  featureCollection: FeatureCollection<Polygon, ParcelFeatureProperties>
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null
  parcelCount: number
}

/**
 * JPGIS のパース結果を GeoJSON に変換する。
 * @param result parseJpgisXml の戻り値
 * @param zone   ソースデータの座標系番号 (JGD2011 平面直角座標系 1-19)
 */
export function jpgisToGeoJson(
  result: JpgisParseResult,
  zone: number,
): JpgisToGeoJsonResult {
  const converter = new CoordinateConverter(zone)

  // 点番号 → JPRC 座標 の索引
  const pointIndex = new Map<string, { x: number; y: number }>()
  for (const c of result.coordinates) {
    pointIndex.set(c.pointNumber, { x: c.x, y: c.y })
  }

  const features: Feature<Polygon, ParcelFeatureProperties>[] = []
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  for (const poly of result.polygons) {
    const jprc: Array<[number, number]> = []
    const ring: Array<[number, number]> = [] // GeoJSON は [lng, lat]

    for (const pn of poly.pointNumbers) {
      const p = pointIndex.get(pn)
      if (!p) continue
      jprc.push([p.x, p.y])
      const { lat, lng } = converter.toLatLng(p.x, p.y)
      ring.push([lng, lat])
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    }
    if (ring.length < 3) continue

    // GeoJSON Polygon は最初と最後の点を閉じる必要がある
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]])
    }

    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        parcel_number: poly.parcelNumber,
        parcel_name: poly.parcelName,
        owner_name: poly.ownerName,
        registered_area_sqm: poly.registeredAreaSqm,
        jprc_coords: jprc,
        source_zone: zone,
      },
    })
  }

  const bbox =
    Number.isFinite(minLng) && Number.isFinite(minLat)
      ? { minLng, minLat, maxLng, maxLat }
      : null

  return {
    featureCollection: { type: 'FeatureCollection', features },
    bbox,
    parcelCount: features.length,
  }
}
