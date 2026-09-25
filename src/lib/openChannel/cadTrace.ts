import type { DxfCalibration } from '@/stores/openChannelStore'

/**
 * CAD 図面 の 点 を 校正 を 通して 実 の 値 に 直す。
 *
 * 図面 は mm 単位、 hScale / vScale は 分母 (100 = 1:100)。
 * 横軸 は 断面 なら 中心 から の 離れ、 縦断 なら SP。 どちら も
 *   横 = (px - 基準X) * hScale / 1000 + シフト
 *   縦 = DL 標高 + (py - DL の Y) * vScale / 1000
 * で 同じ 形 に なる ので、 1 つ の 式 で 両方 を 賄う。
 */
export function dxfToWorld(
  px: number,
  py: number,
  calib: DxfCalibration,
): { offset: number; elevation: number } {
  const offset = ((px - calib.centerX) * calib.hScale) / 1000 + (calib.centerShift ?? 0)
  const elevation = calib.dlElevation + ((py - calib.dlY) * calib.vScale) / 1000
  return {
    offset: Math.round(offset * 1000) / 1000,
    elevation: Math.round(elevation * 1000) / 1000,
  }
}

/** 実 の 値 を 図面 の 位置 に 戻す (dxfToWorld の 逆) */
export function worldToDxf(
  offset: number,
  elevation: number,
  calib: DxfCalibration,
): { x: number; y: number } {
  return {
    x: calib.centerX + ((offset - (calib.centerShift ?? 0)) * 1000) / calib.hScale,
    y: calib.dlY + ((elevation - calib.dlElevation) * 1000) / calib.vScale,
  }
}

/** 縦断 を なぞった 点 (横軸 は SP) */
export interface TracedProfilePoint {
  sp: number
  elevation: number
}

/**
 * なぞった 折れ線 を その SP で 内挿 する。
 * 点列 の 外 は 返さ ない (外挿 は しない — 図面 に 無い もの を 作ら ない)。
 * 同じ SP の 点 が 並ぶ (垂直 な 段差) 場合 は 先 に 来た 方 を 採る。
 */
export function interpolateProfileAt(
  points: readonly TracedProfilePoint[],
  sp: number,
): number | null {
  if (points.length === 0) return null
  const pts = [...points].sort((a, b) => a.sp - b.sp)
  const EPS = 1e-6
  if (sp < pts[0].sp - EPS || sp > pts[pts.length - 1].sp + EPS) return null
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].sp - sp) <= EPS) return Math.round(pts[i].elevation * 1000) / 1000
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (sp > a.sp && sp < b.sp) {
      const t = (sp - a.sp) / (b.sp - a.sp)
      const z = a.elevation + (b.elevation - a.elevation) * t
      return Math.round(z * 1000) / 1000
    }
  }
  return null
}

/**
 * なぞった 縦断 を 測点 の 位置 で 拾い 直す。
 * 図面 に 無い 範囲 の 測点 は 飛ばす ので、 一部 だけ なぞって も 使える。
 */
export function sampleProfileAtStations(
  points: readonly TracedProfilePoint[],
  stations: readonly { id: string; sp: number }[],
): { stationId: string; elevation: number }[] {
  const out: { stationId: string; elevation: number }[] = []
  for (const st of stations) {
    const z = interpolateProfileAt(points, st.sp)
    if (z != null) out.push({ stationId: st.id, elevation: z })
  }
  return out
}
