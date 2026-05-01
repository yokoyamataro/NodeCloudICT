// ジオイドモデル（独自バイナリ）の遅延読込・補間ライブラリ
//
// バイナリは scripts/convert-geoid-isg.mjs で ISG から事前生成され、
// /geoid/jp_geoid_2024.bin として静的配信される。
//
// 使い方:
//   const grid = await loadGeoid()
//   const N = lookupGeoid(grid, lat, lng) // m（範囲外は null）
//   const elevation = ellipsoidalHeight - N - antennaHeight

const MAGIC = 'JGRD'
const DEFAULT_URL = '/geoid/jp_geoid_2024.bin'

export interface GeoidGrid {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
  /** セル間隔（緯度方向、deg） */
  dLat: number
  /** セル間隔（経度方向、deg） */
  dLon: number
  nrows: number
  ncols: number
  /** N-to-S, W-to-E。NaN は欠損 */
  values: Float32Array
}

let cached: GeoidGrid | null = null
let pending: Promise<GeoidGrid> | null = null

export async function loadGeoid(url: string = DEFAULT_URL): Promise<GeoidGrid> {
  if (cached) return cached
  if (pending) return pending
  pending = (async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ジオイドデータの取得に失敗: ${res.status}`)
    const buf = await res.arrayBuffer()
    const grid = parseBinary(buf)
    cached = grid
    return grid
  })()
  try {
    return await pending
  } finally {
    pending = null
  }
}

function parseBinary(buf: ArrayBuffer): GeoidGrid {
  if (buf.byteLength < 64) throw new Error('ジオイドファイルが短すぎます')
  const view = new DataView(buf)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== MAGIC) throw new Error(`未知のフォーマット: magic=${magic}`)
  const version = view.getUint32(4, true)
  if (version !== 1) throw new Error(`未対応バージョン: ${version}`)
  const latMin = view.getFloat64(8, true)
  const latMax = view.getFloat64(16, true)
  const lonMin = view.getFloat64(24, true)
  const lonMax = view.getFloat64(32, true)
  const dLat = view.getFloat64(40, true)
  const dLon = view.getFloat64(48, true)
  const nrows = view.getUint32(56, true)
  const ncols = view.getUint32(60, true)
  const expected = nrows * ncols * 4
  if (buf.byteLength < 64 + expected) throw new Error('ジオイドデータが不足しています')
  const values = new Float32Array(buf, 64, nrows * ncols)
  return { latMin, latMax, lonMin, lonMax, dLat, dLon, nrows, ncols, values }
}

/**
 * 緯度経度の地点で双線形補間したジオイド高 (m) を返す。範囲外や欠損は null。
 */
export function lookupGeoid(grid: GeoidGrid, lat: number, lng: number): number | null {
  if (lat < grid.latMin || lat > grid.latMax || lng < grid.lonMin || lng > grid.lonMax) return null
  // 行は北→南: row = (latMax - lat) / dLat
  const rRow = (grid.latMax - lat) / grid.dLat
  const rCol = (lng - grid.lonMin) / grid.dLon
  const r0 = Math.floor(rRow)
  const c0 = Math.floor(rCol)
  const r1 = Math.min(r0 + 1, grid.nrows - 1)
  const c1 = Math.min(c0 + 1, grid.ncols - 1)
  const tr = rRow - r0
  const tc = rCol - c0
  const v00 = grid.values[r0 * grid.ncols + c0]
  const v01 = grid.values[r0 * grid.ncols + c1]
  const v10 = grid.values[r1 * grid.ncols + c0]
  const v11 = grid.values[r1 * grid.ncols + c1]
  if (Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11)) return null
  const a = v00 * (1 - tc) + v01 * tc
  const b = v10 * (1 - tc) + v11 * tc
  return a * (1 - tr) + b * tr
}

/**
 * 楕円体高 → 標高（ジオイド・アンテナ高補正後）。
 * lookup できない場合は null。
 */
export function correctElevation(
  grid: GeoidGrid,
  ellipsoidalHeight: number,
  lat: number,
  lng: number,
  antennaHeight: number,
): number | null {
  const N = lookupGeoid(grid, lat, lng)
  if (N === null) return null
  return ellipsoidalHeight - N - antennaHeight
}
