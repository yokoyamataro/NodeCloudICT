// Web Mercator XYZ タイル座標と WGS84 経緯度の相互変換。
// 地番マップのサーバー側タイル化で使用する。

export interface TileCoord {
  z: number
  x: number
  y: number
}

export interface Bbox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

/** lng / lat / zoom → タイル (x, y) */
export function lngLatToTile(lng: number, lat: number, z: number): TileCoord {
  const n = Math.pow(2, z)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )
  return { z, x, y }
}

/** タイル (x, y, z) → タイルの左上角 (lng, lat) */
export function tileToLngLat(z: number, x: number, y: number): { lng: number; lat: number } {
  const n = Math.pow(2, z)
  const lng = (x / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lng, lat: (latRad * 180) / Math.PI }
}

/** タイル (x, y, z) の bbox */
export function tileBbox(z: number, x: number, y: number): Bbox {
  const topLeft = tileToLngLat(z, x, y)
  const bottomRight = tileToLngLat(z, x + 1, y + 1)
  return {
    minLng: topLeft.lng,
    minLat: bottomRight.lat,
    maxLng: bottomRight.lng,
    maxLat: topLeft.lat,
  }
}

/** bbox に含まれる全てのタイル座標を列挙 */
export function bboxToTiles(bbox: Bbox, z: number): TileCoord[] {
  const tl = lngLatToTile(bbox.minLng, bbox.maxLat, z) // 左上
  const br = lngLatToTile(bbox.maxLng, bbox.minLat, z) // 右下
  const tiles: TileCoord[] = []
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) {
      tiles.push({ z, x, y })
    }
  }
  return tiles
}

/** 2 つの bbox が交差するか */
export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return !(
    a.maxLng < b.minLng ||
    a.minLng > b.maxLng ||
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat
  )
}

/** 点が bbox に含まれるか */
export function bboxContains(bbox: Bbox, lng: number, lat: number): boolean {
  return (
    lng >= bbox.minLng &&
    lng <= bbox.maxLng &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  )
}

/** GeoJSON Position の並びから bbox を計算 */
export function ringBbox(ring: Array<[number, number]>): Bbox {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const p of ring) {
    const lng = p[0]
    const lat = p[1]
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  return { minLng, minLat, maxLng, maxLat }
}

/** bbox にバッファ (メートル) を足す。緯度によって経度スケールが変わるので簡易換算 */
export function expandBbox(bbox: Bbox, meters: number): Bbox {
  const latDelta = meters / 111_320
  const midLat = (bbox.minLat + bbox.maxLat) / 2
  const lngDelta = meters / (111_320 * Math.cos((midLat * Math.PI) / 180))
  return {
    minLng: bbox.minLng - lngDelta,
    minLat: bbox.minLat - latDelta,
    maxLng: bbox.maxLng + lngDelta,
    maxLat: bbox.maxLat + latDelta,
  }
}

/** タイル座標を文字列キーに */
export function tileKey(t: TileCoord): string {
  return `${t.z}/${t.x}/${t.y}`
}
