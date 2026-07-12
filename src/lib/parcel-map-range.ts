// 法務省地図レイヤの表示範囲プリセット。
// 境界測量画面 / モバイル杭打ち / モバイル詳細地図 で共通利用。
//
// 数値 (m) は「工区座標由来の bbox + そのバッファ」。
// 'viewport' は「地図の現在ビューポートに追従」(ParcelMapLayer が × 2 バッファ)。

import { CoordinateConverter } from '@/lib/coordinates'
import { expandBbox, ringBbox, type Bbox } from '@/lib/tile-math'

export type ParcelRange = '100' | '300' | '500' | '1000' | 'viewport'

export const PARCEL_RANGE_OPTIONS: Array<{ value: ParcelRange; label: string }> = [
  { value: '100', label: '工区+100m' },
  { value: '300', label: '工区+300m' },
  { value: '500', label: '工区+500m' },
  { value: '1000', label: '工区+1km' },
  { value: 'viewport', label: '現在のビュー' },
]

export const DEFAULT_PARCEL_RANGE: ParcelRange = '300'

/** 保存値 (localStorage 等) から ParcelRange を復元。未知値は DEFAULT_PARCEL_RANGE */
export function parseParcelRange(v: string | null | undefined): ParcelRange {
  if (v === '100' || v === '300' || v === '500' || v === '1000' || v === 'viewport') {
    return v
  }
  return DEFAULT_PARCEL_RANGE
}

/** 工区座標 (JPRC x,y) + zone から bbox (WGS84) を計算し、range に応じて拡張する。
 *  viewport モード or 座標なし の場合は null → 呼び出し側で ParcelMapLayer が
 *  ビューポート追従にフォールバックする。 */
export function computeParcelBbox(
  range: ParcelRange,
  coordinates: Array<{ x: number; y: number }>,
  zone: number,
): Bbox | null {
  if (range === 'viewport') return null
  if (coordinates.length === 0) return null
  const conv = new CoordinateConverter(zone)
  const points: Array<[number, number]> = coordinates.map((c) => {
    const { lat, lng } = conv.toLatLng(c.x, c.y)
    return [lng, lat]
  })
  if (points.length === 0) return null
  return expandBbox(ringBbox(points), parseInt(range, 10))
}
