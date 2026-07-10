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

import type { FeatureCollection, Feature, Polygon, Position } from 'geojson'
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

    // parcel_number は「地番」(Kakuchi.Name 例: "67", "1-24") を優先で入れる。
    // Kakuchi.Number は SIMA 内の連番であり地図表示には不向き。
    // (GeoJSON 直接インポートと整合させるため)
    const chibanText = poly.parcelName || poly.parcelNumber
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        parcel_number: chibanText,
        parcel_name: chibanText,
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

// --------------------------------------------------------------------
// G 空間情報センター配布の 法務省登記所備付地図 GeoJSON を我々の
// ParcelFeatureProperties にマッピングして正規化する。
//
// 想定 properties (日本語キー):
//   ID, 市区町村C, 市区町村名, 大字コード, 大字名, 地番, 座標系, 精度区分, ...
// 座標は WGS84 経度緯度 (CRS84) — 我々の描画パイプラインにそのまま流せる。
// 所有者・登記面積は含まれない (プライバシー保護)。
// jprc_coords は空配列。取込時に WGS84 → プロジェクト座標系に再投影する。
// --------------------------------------------------------------------

export interface NormalizeGovParcelResult extends JpgisToGeoJsonResult {
  /** 属性の「座標系」から検出された系番号 (1-19)。検出できなければ null */
  detectedZone: number | null
}

type GovProps = Record<string, unknown>

function toStringOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}

/** "公共座標13系" のような文字列から系番号を取り出す。取れなければ null */
function extractZone(csText: unknown): number | null {
  if (typeof csText !== 'string') return null
  const m = csText.match(/(\d{1,2})\s*系/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return n >= 1 && n <= 19 ? n : null
}

/** 大字名 + 地番 を「字富士 152-4」の形で組み立てる */
function buildParcelName(props: GovProps): { number: string; label: string } {
  const chiban = toStringOrNull(props['地番']) ?? ''
  const ooaza = toStringOrNull(props['大字名']) ?? ''
  const chome = toStringOrNull(props['丁目名']) ?? ''
  const idFallback = toStringOrNull(props['ID']) ?? ''
  const number = chiban || idFallback
  const label = [ooaza, chome, chiban].filter((s) => s.length > 0).join(' ') || number
  return { number, label }
}

export function normalizeGovParcelGeoJson(
  raw: unknown,
): NormalizeGovParcelResult {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { type?: string }).type !== 'FeatureCollection' ||
    !Array.isArray((raw as { features?: unknown }).features)
  ) {
    throw new Error('GeoJSON の形式が正しくありません (FeatureCollection ではない)')
  }

  const rawFeatures = (raw as { features: unknown[] }).features
  const features: Feature<Polygon, ParcelFeatureProperties>[] = []
  let detectedZone: number | null = null
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  for (const rf of rawFeatures) {
    if (!rf || typeof rf !== 'object') continue
    const f = rf as Feature<Polygon, GovProps>
    if (f.type !== 'Feature') continue
    if (!f.geometry || f.geometry.type !== 'Polygon') continue
    const coords = f.geometry.coordinates
    if (!Array.isArray(coords) || coords.length === 0) continue

    const props: GovProps = f.properties ?? {}
    const { number, label } = buildParcelName(props)
    const zoneHere = extractZone(props['座標系'])
    if (detectedZone == null && zoneHere != null) detectedZone = zoneHere

    // bbox 計算 (外周のみで良い)
    const outer = coords[0] as Position[]
    for (const p of outer) {
      const lng = p[0]
      const lat = p[1]
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    }

    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        parcel_number: number,
        parcel_name: label,
        owner_name: toStringOrNull(props['所有者']),
        registered_area_sqm: toNumberOrNull(props['面積']),
        // GeoJSON 直接ソースは原 JPRC を持たない。取込時は WGS84 から再投影する。
        jprc_coords: [],
        source_zone: zoneHere ?? 0, // 検出できないとき 0 (取込側で「異ゾーン扱い」→ 再投影で救う)
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
    detectedZone,
  }
}
