// TKY2JGD + PATCHJGD 座標 変換 ライブラリ (TypeScript 版)。
//
// 国土地理院 の TKY2JGD.par (日本測地系 → 世界測地系) と、 地震毎 の
// patchjgd (地殻変動補正) に 対応。 入出力 は 平面直角座標 (X=北, Y=東) [m]。
//
// 元 ネタ: https://github.com/yokoyamataro/TKY-JGD-PATCH converter.js
//          (さらに その 元 は 国土地理院 TKY2JGD の VB6 ソース)

export type EllipsoidType = 'bessel' | 'grs80'

interface Ellipsoid {
  a: number
  f1: number
  f: number
  e: number
}

const BESSEL: Ellipsoid = (() => {
  const a = 6377397.155
  const f1 = 299.152813
  const f = 1 / f1
  return { a, f1, f, e: 2 * f - f * f }
})()

const GRS80: Ellipsoid = (() => {
  const a = 6378137.0
  const f1 = 298.257222101
  const f = 1 / f1
  return { a, f1, f, e: 2 * f - f * f }
})()

const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180
const M0 = 0.9999

/** 平面直角 系番号 → 原点 緯度経度 (DDDMMSS 形式) */
const SYSTEM_ORIGINS: Record<number, { lat: number; lng: number; name: string }> = {
  1: { lat: 330000, lng: 1293000, name: '長崎県、鹿児島県の一部' },
  2: { lat: 330000, lng: 1310000, name: '福岡県、佐賀県、熊本県、大分県、宮崎県、鹿児島県の一部' },
  3: { lat: 360000, lng: 1321000, name: '山口県、島根県、広島県' },
  4: { lat: 330000, lng: 1333000, name: '香川県、愛媛県、徳島県、高知県' },
  5: { lat: 360000, lng: 1342000, name: '兵庫県、鳥取県、岡山県' },
  6: { lat: 360000, lng: 1360000, name: '京都府、大阪府、福井県、滋賀県、三重県、奈良県、和歌山県' },
  7: { lat: 360000, lng: 1371000, name: '石川県、富山県、岐阜県、愛知県' },
  8: { lat: 360000, lng: 1383000, name: '新潟県、長野県、山梨県、静岡県' },
  9: { lat: 360000, lng: 1395000, name: '東京都（島嶼部除く）、福島県、栃木県、茨城県、埼玉県、千葉県、群馬県、神奈川県' },
  10: { lat: 400000, lng: 1405000, name: '青森県、秋田県、山形県、岩手県、宮城県' },
  11: { lat: 440000, lng: 1401500, name: '北海道（西部）' },
  12: { lat: 440000, lng: 1421500, name: '北海道（中央部）' },
  13: { lat: 440000, lng: 1441500, name: '北海道（東部）' },
  14: { lat: 260000, lng: 1420000, name: '東京都（島嶼部の一部）' },
  15: { lat: 260000, lng: 1273000, name: '沖縄県' },
  16: { lat: 260000, lng: 1240000, name: '沖縄県（先島諸島）' },
  17: { lat: 260000, lng: 1310000, name: '沖縄県（大東諸島）' },
  18: { lat: 200000, lng: 1360000, name: '東京都（小笠原諸島）' },
  19: { lat: 260000, lng: 1540000, name: '東京都（南鳥島）' },
}

/** メッシュコード → {dB, dL} の グリッド */
export interface Grid {
  data: Map<number, { dB: number; dL: number }>
  name: string
  description: string
}

/** DDDMMSS.SSS → 度 */
function dms2deg(dms: number): number {
  const sign = Math.sign(dms)
  const absDms = Math.abs(dms / 10000) + 1e-13
  const d = Math.floor(absDms)
  const ams = (absDms - d) * 100
  const m = Math.floor(ams)
  const s = (ams - m) * 100
  return (d + (m + s / 60) / 60) * sign
}

/** .par テキスト を メッシュコード map に パース */
export function parseGrid(fileContent: string, options: { name?: string; headerLines?: number } = {}): Grid {
  const name = options.name ?? ''
  const data = new Map<number, { dB: number; dL: number }>()
  const lines = fileContent.split(/\r?\n/)
  let description = ''

  // ヘッダー検出: "MeshCode" を 含む 行 の 次 から データ。
  // 標準 TKY2JGD は ヘッダー 2 行、 patchjgd は 15 行 程度。
  // 自動 判定 で 両方 対応。
  let dataStart = options.headerLines ?? 2
  for (let i = 0; i < Math.min(20, lines.length); i += 1) {
    if (lines[i].includes('MeshCode') && lines[i].includes('dB')) {
      dataStart = i + 1
      break
    }
  }
  if (dataStart > 1 && lines.length > 1) {
    const descLine = lines[1]
    if (descLine && !descLine.startsWith('MeshCode')) {
      description = descLine.trim()
    }
  }

  for (let i = dataStart; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const meshCode = parseInt(parts[0], 10)
    const dB = parseFloat(parts[1])
    const dL = parseFloat(parts[2])
    if (!Number.isNaN(meshCode) && !Number.isNaN(dB) && !Number.isNaN(dL)) {
      data.set(meshCode, { dB, dL })
    }
  }
  return { data, name, description }
}

/** 緯度経度 → 3 次 メッシュコード + メッシュ内 相対位置 (0-1) */
function latLon2MeshCode(lat: number, lng: number): { meshCode: number; modLat: number; modLon: number } {
  const mc1 = Math.floor(lat * 1.5) * 100 + Math.floor(lng - 100)
  const latRem1 = lat * 1.5 - Math.floor(lat * 1.5)
  const lngRem1 = lng - Math.floor(lng)
  const mc2 = Math.floor(latRem1 * 8) * 10 + Math.floor(lngRem1 * 8)
  const latRem2 = latRem1 * 8 - Math.floor(latRem1 * 8)
  const lngRem2 = lngRem1 * 8 - Math.floor(lngRem1 * 8)
  const mc3 = Math.floor(latRem2 * 10) * 10 + Math.floor(lngRem2 * 10)
  const meshCode = mc1 * 10000 + mc2 * 100 + mc3
  const modLat = latRem2 * 10 - Math.floor(latRem2 * 10)
  const modLon = lngRem2 * 10 - Math.floor(lngRem2 * 10)
  return { meshCode, modLat, modLon }
}

/** 東 / 北 / 北東 の 隣接 メッシュコード */
function getAdjacentMeshCodes(mc: number): { mcE: number; mcN: number; mcNE: number } {
  const mc1 = Math.floor(mc / 10000)
  const mc2 = Math.floor((mc % 10000) / 100)
  const mc3 = mc % 100
  const lat3 = Math.floor(mc3 / 10)
  const lng3 = mc3 % 10
  const lat2 = Math.floor(mc2 / 10)
  const lng2 = mc2 % 10
  const lat1 = Math.floor(mc1 / 100)
  const lng1 = mc1 % 100

  let eLng3 = lng3 + 1
  let eLng2 = lng2
  let eLng1 = lng1
  if (eLng3 > 9) { eLng3 = 0; eLng2 += 1 }
  if (eLng2 > 7) { eLng2 = 0; eLng1 += 1 }
  const mcE = (lat1 * 100 + eLng1) * 10000 + (lat2 * 10 + eLng2) * 100 + lat3 * 10 + eLng3

  let nLat3 = lat3 + 1
  let nLat2 = lat2
  let nLat1 = lat1
  if (nLat3 > 9) { nLat3 = 0; nLat2 += 1 }
  if (nLat2 > 7) { nLat2 = 0; nLat1 += 1 }
  const mcN = (nLat1 * 100 + lng1) * 10000 + (nLat2 * 10 + lng2) * 100 + nLat3 * 10 + lng3
  const mcNE = (nLat1 * 100 + eLng1) * 10000 + (nLat2 * 10 + eLng2) * 100 + nLat3 * 10 + eLng3
  return { mcE, mcN, mcNE }
}

function bilinear(u1: number, u2: number, u3: number, u4: number, x: number, y: number): number {
  const a = u1
  const b = u2 - u1
  const c = u3 - u1
  const d = u4 - u2 - u3 + u1
  return a + b * x + c * y + d * x * y
}

/**
 * グリッド で 緯度経度 を 補正。
 * 4 隅 揃わ ない 時 は { found: false }。 patchjgd は 自分 の 位置 だけ ある 場合 は
 * nearest 法 で 1 点 の 値 を 返す。
 */
function interpGrid(
  grid: Grid,
  lat: number,
  lng: number,
  options: { allowNearest?: boolean } = {},
): { dB: number; dL: number; found: boolean; method: 'bilinear' | 'nearest' | 'none' } {
  if (lat < 20 || lat > 46 || lng < 120 || lng > 154) {
    return { dB: 0, dL: 0, found: false, method: 'none' }
  }
  const mc0 = latLon2MeshCode(lat, lng)
  const adj = getAdjacentMeshCodes(mc0.meshCode)
  const p0 = grid.data.get(mc0.meshCode)
  const pE = grid.data.get(adj.mcE)
  const pN = grid.data.get(adj.mcN)
  const pNE = grid.data.get(adj.mcNE)
  if (!p0 || !pE || !pN || !pNE) {
    if (options.allowNearest && p0) {
      return { dB: p0.dB, dL: p0.dL, found: true, method: 'nearest' }
    }
    return { dB: 0, dL: 0, found: false, method: 'none' }
  }
  const dB = bilinear(p0.dB, pE.dB, pN.dB, pNE.dB, mc0.modLon, mc0.modLat)
  const dL = bilinear(p0.dL, pE.dL, pN.dL, pNE.dL, mc0.modLon, mc0.modLat)
  return { dB, dL, found: true, method: 'bilinear' }
}

/** 赤道 から 緯度 phi [rad] までの 子午線 弧長 [m] */
function meridianArc(phi: number, ell: Ellipsoid): number {
  const e2 = ell.e
  const e4 = e2 * e2
  const e6 = e4 * e2
  const e8 = e4 * e4
  const e10 = e8 * e2
  const e12 = e8 * e4
  const e14 = e8 * e6
  const e16 = e8 * e8
  const AEE = ell.a * (1 - e2)

  let AJ = 4927697775 / 7516192768 * e16 + 19324305 / 29360128 * e14 + 693693 / 1048576 * e12
  AJ += 43659 / 65536 * e10 + 11025 / 16384 * e8 + 175 / 256 * e6 + 45 / 64 * e4 + 3 / 4 * e2 + 1
  let BJ = 547521975 / 469762048 * e16 + 135270135 / 117440512 * e14 + 297297 / 262144 * e12
  BJ += 72765 / 65536 * e10 + 2205 / 2048 * e8 + 525 / 512 * e6 + 15 / 16 * e4 + 3 / 4 * e2
  let CJ = 766530765 / 939524096 * e16 + 45090045 / 58720256 * e14 + 1486485 / 2097152 * e12
  CJ += 10395 / 16384 * e10 + 2205 / 4096 * e8 + 105 / 256 * e6 + 15 / 64 * e4
  let DJ = 209053845 / 469762048 * e16 + 45090045 / 117440512 * e14 + 165165 / 524288 * e12
  DJ += 31185 / 131072 * e10 + 315 / 2048 * e8 + 35 / 512 * e6
  let EJ = 348423075 / 1879048192 * e16 + 4099095 / 29360128 * e14 + 99099 / 1048576 * e12
  EJ += 3465 / 65536 * e10 + 315 / 16384 * e8
  const FJ = 26801775 / 469762048 * e16 + 4099095 / 117440512 * e14 + 9009 / 524288 * e12 + 693 / 131072 * e10
  const GJ = 11486475 / 939524096 * e16 + 315315 / 58720256 * e14 + 3003 / 2097152 * e12
  const HJ = 765765 / 469762048 * e16 + 45045 / 117440512 * e14
  const IJ = 765765 / 7516192768 * e16

  let S = IJ / 16 * Math.sin(16 * phi)
  S -= HJ / 14 * Math.sin(14 * phi)
  S += GJ / 12 * Math.sin(12 * phi)
  S -= FJ / 10 * Math.sin(10 * phi)
  S += EJ / 8 * Math.sin(8 * phi)
  S -= DJ / 6 * Math.sin(6 * phi)
  S += CJ / 4 * Math.sin(4 * phi)
  S -= BJ / 2 * Math.sin(2 * phi)
  S += AJ * phi
  return AEE * S
}

/** 平面直角 (X, Y) → 緯度経度 [度] (ellipsoid 指定) */
export function xy2bl(X: number, Y: number, systemNo: number, ellipsoidType: EllipsoidType = 'bessel'): { lat: number; lng: number } {
  const system = SYSTEM_ORIGINS[systemNo]
  if (!system) throw new Error(`座標系 ${systemNo} は 存在 しません`)
  const ell = ellipsoidType === 'bessel' ? BESSEL : GRS80
  const B1 = dms2deg(system.lat) * DEG2RAD
  const L1 = dms2deg(system.lng) * DEG2RAD
  const e2 = ell.e
  const Ep2 = e2 / (1 - e2)
  const CEE = ell.a / Math.sqrt(1 - e2)
  const S0 = meridianArc(B1, ell)
  const M = S0 + X / M0

  // ニュートン法 で 底緯度 phi1 を 求める
  let phi1 = B1
  for (let i = 0; i < 100; i += 1) {
    const old = phi1
    const S1 = meridianArc(phi1, ell)
    const s = Math.sin(phi1)
    const c = Math.cos(phi1)
    const W = 1 - e2 * s * s
    const num = 2 * (S1 - M) * Math.pow(W, 1.5)
    const den = 3 * e2 * (S1 - M) * s * c * Math.sqrt(W) - 2 * ell.a * (1 - e2)
    phi1 = phi1 + num / den
    if (Math.abs(phi1 - old) < 1e-14) break
  }

  const YM0 = Y / M0
  const T = Math.tan(phi1)
  const T2 = T * T
  const T4 = T2 * T2
  const T6 = T4 * T2
  const cosPhi1 = Math.cos(phi1)
  const Eta2 = Ep2 * cosPhi1 * cosPhi1
  const N1 = CEE / Math.sqrt(1 + Eta2)
  const N1cos = N1 * cosPhi1

  let B =
    ((1385 + 3633 * T2 + 4095 * T4 + 1575 * T6) / (40320 * Math.pow(N1, 8))) * Math.pow(YM0, 8)
  B -=
    ((61 + 90 * T2 + 45 * T4 + 107 * Eta2 - 162 * T2 * Eta2 - 45 * T4 * Eta2) /
      (720 * Math.pow(N1, 6))) *
    Math.pow(YM0, 6)
  B +=
    ((5 + 3 * T2 + 6 * Eta2 - 6 * T2 * Eta2 - 3 * Eta2 * Eta2 - 9 * T2 * Eta2 * Eta2) /
      (24 * Math.pow(N1, 4))) *
    Math.pow(YM0, 4)
  B -= ((1 + Eta2) / (2 * N1 * N1)) * YM0 * YM0
  B = B * T + phi1

  let L =
    -((61 + 662 * T2 + 1320 * T4 + 720 * T6) / (5040 * Math.pow(N1, 6) * N1cos)) *
    Math.pow(YM0, 7)
  L += ((5 + 28 * T2 + 24 * T4 + 6 * Eta2 + 8 * T2 * Eta2) / (120 * Math.pow(N1, 4) * N1cos)) * Math.pow(YM0, 5)
  L -= ((1 + 2 * T2 + Eta2) / (6 * N1 * N1 * N1cos)) * Math.pow(YM0, 3)
  L += (1 / N1cos) * YM0
  L += L1
  return { lat: B * RAD2DEG, lng: L * RAD2DEG }
}

/** 緯度経度 [度] → 平面直角 (X, Y) */
export function bl2xy(lat: number, lng: number, systemNo: number, ellipsoidType: EllipsoidType = 'grs80'): { X: number; Y: number } {
  const system = SYSTEM_ORIGINS[systemNo]
  if (!system) throw new Error(`座標系 ${systemNo} は 存在 しません`)
  const ell = ellipsoidType === 'bessel' ? BESSEL : GRS80
  const B1 = dms2deg(system.lat) * DEG2RAD
  const L1 = dms2deg(system.lng) * DEG2RAD
  const B = lat * DEG2RAD
  const L = lng * DEG2RAD
  const dL = L - L1
  const e2 = ell.e
  const Ep2 = e2 / (1 - e2)
  const CEE = ell.a / Math.sqrt(1 - e2)

  const T = Math.tan(B)
  const T2 = T * T
  const T4 = T2 * T2
  const T6 = T4 * T2
  const cosB = Math.cos(B)
  const COS2 = cosB * cosB
  const Eta2phi = Ep2 * COS2
  const Nphi = CEE / Math.sqrt(1 + Eta2phi)
  const DL2 = dL * dL
  const DL4 = DL2 * DL2
  const DL6 = DL4 * DL2
  const S = meridianArc(B, ell)
  const S0 = meridianArc(B1, ell)

  let X = -(-1385 + 3111 * T2 - 543 * T4 + T6) * DL6 * Math.pow(COS2, 3) / 40320
  X -= (-61 + 58 * T2 - T4 - 270 * Eta2phi + 330 * T2 * Eta2phi) * DL4 * COS2 * COS2 / 720
  X += (5 - T2 + 9 * Eta2phi + 4 * Eta2phi * Eta2phi) * DL2 * COS2 / 24
  X += 0.5
  X *= Nphi * COS2 * T * DL2
  X += S - S0
  X *= M0

  let Y = -(-61 + 479 * T2 - 179 * T4 + T6) * DL6 * Math.pow(COS2, 3) / 5040
  Y -= (-5 + 18 * T2 - T4 - 14 * Eta2phi + 58 * T2 * Eta2phi) * DL4 * COS2 * COS2 / 120
  Y -= (-1 + T2 - Eta2phi) * DL2 * COS2 / 6
  Y += 1
  Y *= Nphi * cosB * dL
  Y *= M0
  return { X, Y }
}

export interface ConvertResult {
  X: number
  Y: number
  /** TKY2JGD / PATCHJGD が 適用 できた 点 なら true */
  ok: boolean
  /** エラー メッセージ (ok=false の 時) */
  reason?: string
  dX?: number
  dY?: number
}

/**
 * 1 点 を 変換:
 *   - tkyGrid が 渡された ら TKY2JGD (日本測地系 → JGD2000)
 *   - patchGrid が 渡された ら PATCHJGD (地殻変動補正)
 *   - 両方 無し なら 入力 を そのまま 返す (no-op)
 */
export function convertPoint(
  X: number,
  Y: number,
  systemNo: number,
  options: { tkyGrid?: Grid; patchGrid?: Grid },
): ConvertResult {
  try {
    // 入力 の 楕円体 は TKY2JGD を 適用 する か 否か で 変わる:
    //   - 適用 する: 日本測地系 (Bessel)
    //   - 適用 しない: 世界測地系 (GRS80)
    const inputEllipsoid: EllipsoidType = options.tkyGrid ? 'bessel' : 'grs80'
    const bl = xy2bl(X, Y, systemNo, inputEllipsoid)
    let lat = bl.lat
    let lng = bl.lng

    if (options.tkyGrid) {
      const g = interpGrid(options.tkyGrid, lat, lng)
      if (!g.found) {
        return { X, Y, ok: false, reason: 'TKY2JGD グリッド 範囲 外' }
      }
      lat = lat + g.dB / 3600
      lng = lng + g.dL / 3600
    }

    if (options.patchGrid) {
      const g = interpGrid(options.patchGrid, lat, lng, { allowNearest: true })
      if (!g.found) {
        return { X, Y, ok: false, reason: '地殻変動補正 グリッド 範囲 外' }
      }
      lat = lat + g.dB / 3600
      lng = lng + g.dL / 3600
    }

    const xy = bl2xy(lat, lng, systemNo, 'grs80')
    return { X: xy.X, Y: xy.Y, ok: true, dX: xy.X - X, dY: xy.Y - Y }
  } catch (err) {
    return { X, Y, ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
