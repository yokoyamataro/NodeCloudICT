// 線形物の 中間点 (SP) について、計画横断の 頂点を 平面座標に 落とす。
//
// 線形登録の 画面 (OpenChannelAlignmentPage) と スマホの 測設画面が 同じ 結果に
// なるよう、ここ 1 か所に 置く。計画横断点の 誘導は この 出力を そのまま 使う。

import {
  elementStep,
  type ProfilePoint,
  type SideOrientation,
  type StandardCrossSection,
  type StationRow,
} from '@/stores/openChannelStore'
import {
  pointAtDistance,
  tangentAtDistance,
  type AlignmentSegment,
} from '@/lib/openChannel/alignment'

/**
 * 中間点 1 つの断面要素境界点を、平面座標 (x_north, y_east) + 標高 z にプロジェクションして返す。
 *
 * - sideOrientation='forward': BP→EP を見て右が +、左が -
 * - sideOrientation='reverse': EP→BP を見て右が +、左が -
 * - 標高 z = 中心線床高（profile_points を線形補間） + 断面要素累積高さ
 * - 直立要素 (slopeUnit='vertical') は水平移動 0 (前頂点と同じ平面位置に重なる)。
 */
export type StationVertex = {
  x: number
  y: number
  z: number
  offset: number // 中心からの符号付き水平距離 (m)、正=ユーザー視点の右
  localH: number // 中心床高からの局所高さ (m)
  label: string
  side: 'right' | 'left' | 'center'
}

/**
 * 縦断曲線 (対称 2 次放物線)。VCL > 0 の 中間 変化点 (PVI) について、
 * BVC (=PVI-VCL/2) 〜 EVC (=PVI+VCL/2) の 範囲 に 割り付ける。
 *
 * i1, i2 は 前後 の 勾配 (%, 符号付き)。
 * M = (i1 - i2) / 800 × VCL  (m、凸型で 正 → PVI より 下)
 * Y = (i1 - i2) / (200 × VCL) × X²  (X は BVC からの 距離)
 * i (代数的 勾配差) = i2 - i1
 * VCR = VCL / |i|  (m/%)
 */
export interface VerticalCurve {
  pviIndex: number     // sortedProfile 上 の インデックス
  pviDistance: number  // PVI の 追加距離 (m)
  pviHeight: number    // PVI の 計画高 (m)
  vcl: number
  i1Percent: number    // 前 勾配 (%, 符号付き)
  i2Percent: number    // 後ろ 勾配 (%, 符号付き)
  bvcDistance: number
  bvcHeight: number
  evcDistance: number
  evcHeight: number
  /** 縦距 M (m)、凸型 で 正 (曲線 が PVI より 下) */
  m: number
  /** 代数的 勾配差 A = i2 - i1 (%)、凸型 で 負、凹型 で 正 */
  aPercent: number
  /** 縦断曲線半径相当 VCR = VCL / |A| (m/%) */
  vcr: number
}

/** ソート済 profilePoints から VCL > 0 の 縦断曲線 列 を 抽出。 */
export function computeVerticalCurves(
  sortedProfile: ProfilePoint[],
): VerticalCurve[] {
  const out: VerticalCurve[] = []
  for (let i = 1; i < sortedProfile.length - 1; i++) {
    const prev = sortedProfile[i - 1]
    const pvi = sortedProfile[i]
    const next = sortedProfile[i + 1]
    const vcl = pvi.vcl ?? 0
    if (!Number.isFinite(vcl) || vcl <= 1e-6) continue
    const d1 = pvi.distance - prev.distance
    const d2 = next.distance - pvi.distance
    if (d1 <= 1e-9 || d2 <= 1e-9) continue
    // 勾配 (%). 上り +、下り -
    const i1 = ((pvi.floorHeight - prev.floorHeight) / d1) * 100
    const i2 = ((next.floorHeight - pvi.floorHeight) / d2) * 100
    // BVC / EVC が 隣接 変化点 を 越え ない 範囲 に クランプ
    const halfL = vcl / 2
    if (halfL > d1 + 1e-9 || halfL > d2 + 1e-9) continue
    const bvcDistance = pvi.distance - halfL
    const evcDistance = pvi.distance + halfL
    const bvcHeight = pvi.floorHeight - (i1 / 100) * halfL
    const evcHeight = pvi.floorHeight + (i2 / 100) * halfL
    const m = ((i1 - i2) / 800) * vcl
    const aPercent = i2 - i1
    const vcr = Math.abs(aPercent) < 1e-9 ? Infinity : vcl / Math.abs(aPercent)
    out.push({
      pviIndex: i,
      pviDistance: pvi.distance,
      pviHeight: pvi.floorHeight,
      vcl,
      i1Percent: i1,
      i2Percent: i2,
      bvcDistance,
      bvcHeight,
      evcDistance,
      evcHeight,
      m,
      aPercent,
      vcr,
    })
  }
  return out
}

/**
 * 縦断曲線 (放物線) を 考慮 した 標高 (計画高) を X 位置 で 補間 する。
 * BVC 〜 EVC の 範囲 では 放物線 (Y = BVC + i1/100 × X + (i2-i1)/(200×L) × X²、
 * X は BVC からの 距離) を 使用。 それ 以外 は 直線 補間。
 * 端点を 超えたら クランプ (端点値 を 返す)。
 * ※ 「範囲外は 計画高 なし」扱い を したい 呼び出し側 は interpolateProfileZOrNull を 使う。
 */
export function interpolateProfileZ(
  profilePoints: ProfilePoint[],
  distance: number,
): number {
  if (profilePoints.length === 0) return 0
  const sorted = [...profilePoints].sort((a, b) => a.distance - b.distance)
  if (distance <= sorted[0].distance) return sorted[0].floorHeight
  const last = sorted[sorted.length - 1]
  if (distance >= last.distance) return last.floorHeight

  // 該当 位置 が いずれか の 縦断曲線 範囲内 なら 放物線 で 計算
  const curves = computeVerticalCurves(sorted)
  for (const c of curves) {
    if (distance >= c.bvcDistance && distance <= c.evcDistance) {
      const x = distance - c.bvcDistance
      const linear = c.bvcHeight + (c.i1Percent / 100) * x
      const offset = ((c.i2Percent - c.i1Percent) / (200 * c.vcl)) * x * x
      return linear + offset
    }
  }

  // それ 以外 は 隣接 2 点 で 直線 補間
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (distance >= a.distance && distance <= b.distance) {
      const dx = b.distance - a.distance
      if (dx < 1e-9) return a.floorHeight
      const t = (distance - a.distance) / dx
      return a.floorHeight + (b.floorHeight - a.floorHeight) * t
    }
  }
  return last.floorHeight
}

export function computeStationVertices(
  station: StationRow,
  standardCS: StandardCrossSection,
  profilePoints: ProfilePoint[],
  segments: AlignmentSegment[],
  sideOrientation: SideOrientation,
): StationVertex[] {
  const cs = station.crossSection ?? standardCS
  const center = pointAtDistance(segments, station.distance)
  const tangent = tangentAtDistance(segments, station.distance)
  if (!center || !tangent) return []
  const sign = sideOrientation === 'forward' ? 1 : -1
  // (x=北, y=東) 系で進行方向 (tx, ty) の CCW 90° = (-ty, tx) が地図上の進行方向の右。
  // sign=-1 で河川向き（EP→BP 視点の右 = BP→EP 視点の左）に反転。
  const perp = { x: -tangent.y * sign, y: tangent.x * sign }
  const centerZ = interpolateProfileZ(profilePoints, station.distance)
  const out: StationVertex[] = [
    {
      x: center.x,
      y: center.y,
      z: centerZ,
      offset: 0,
      localH: 0,
      label: 'CL',
      side: 'center',
    },
  ]
  let cum = 0
  let localH = 0
  for (let i = 0; i < cs.right.length; i++) {
    const e = cs.right[i]
    const step = elementStep(e, 1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `R${i + 1}`,
      side: 'right',
    })
  }
  cum = 0
  localH = 0
  for (let i = 0; i < cs.left.length; i++) {
    const e = cs.left[i]
    const step = elementStep(e, -1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `L${i + 1}`,
      side: 'left',
    })
  }
  return out
}
