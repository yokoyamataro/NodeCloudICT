// 線形物 (open channel) の 中心線 に 沿って LandXML の TIN から
// 現況 の 横断 / 縦断 (中心地盤高) を サンプリングする ヘルパ。
//
// - 座標系 は 平面直角 (JGD): x=北, y=東 (openChannel/alignment.ts と 同じ 慣習)
// - tangentAtDistance の 進行方向 (t) に 対し、地図上 の 進行方向 右手 は
//   CCW 90° = (-t.y, t.x)。 sideOrientation='reverse' (河川向き) で 反転。
// - queryZ (barycentric 補間) は 三角形外 で null を 返す ため、TIN 外 の 点は
//   スキップ (現況 データ 空欄 と 扱う)。
//
// パラメータ:
//   halfWidth: 中心 から 左右 に 何 m まで 拾う か (m)
//   step     : offset 刻み (m)。 例 halfWidth=10, step=0.5 → 41 点
//
// 出力:
//   sampleStationCrossSection → MeasuredCrossPoint[] (中心を 含み、左端 → 右端 の 順)
//   sampleStationCenterZ      → 中心 (offset=0) の Z、TIN 外 なら null

import {
  type AlignmentSegment,
  pointAtDistance,
  tangentAtDistance,
} from './alignment'
import type { TinIndex } from '../landxml/tinInterpolation'
import { queryZ } from '../landxml/tinInterpolation'
import type { MeasuredCrossPoint, SideOrientation } from '@/stores/openChannelStore'

/**
 * 指定 station (BP からの 内部距離 distance) の 位置で、TIN から
 * 中心線 に 垂直な 断面点列 を 生成する。
 *
 * @returns 拾えた 点 のみ の 配列 (TIN 外 は 除外)。 全滅で 空配列。
 *          点 id は station 単位 で 決定的 (再取込 で 上書き 可能に)。
 */
export function sampleStationCrossSection(
  tinIdx: TinIndex,
  segments: AlignmentSegment[],
  distance: number,
  sideOrientation: SideOrientation,
  halfWidth: number,
  step: number,
  stationId: string,
): MeasuredCrossPoint[] {
  const c = pointAtDistance(segments, distance)
  const t = tangentAtDistance(segments, distance)
  if (!c || !t) return []
  const sign = sideOrientation === 'reverse' ? -1 : 1
  // 右手 単位 法線 (CCW 90°)。 x=北 / y=東 系 で 進行方向 の 右
  const perp = { x: -t.y * sign, y: t.x * sign }

  const out: MeasuredCrossPoint[] = []
  const n = Math.max(1, Math.floor(halfWidth / step))
  for (let i = -n; i <= n; i++) {
    const offset = i * step
    // 端 の 微小 な 丸め誤差 で halfWidth を 超えない よう クランプ
    const clamped = Math.max(-halfWidth, Math.min(halfWidth, offset))
    const px = c.x + clamped * perp.x
    const py = c.y + clamped * perp.y
    const z = queryZ(tinIdx, px, py)
    if (z == null) continue
    out.push({
      id: `tin-${stationId}-${i >= 0 ? 'r' : 'l'}-${Math.abs(i)}`,
      offset: Math.round(clamped * 1000) / 1000,
      elevation: Math.round(z * 1000) / 1000,
    })
  }
  return out
}

/**
 * 中心線 上 (offset=0) の Z を 直接 拾う ヘルパ。 縦断 (currentGroundHeight)
 * 用途。 station 単位 の 現況高 取得 に 使う。
 * TIN 外 なら null。
 */
export function sampleStationCenterZ(
  tinIdx: TinIndex,
  segments: AlignmentSegment[],
  distance: number,
): number | null {
  const c = pointAtDistance(segments, distance)
  if (!c) return null
  const z = queryZ(tinIdx, c.x, c.y)
  if (z == null) return null
  return Math.round(z * 1000) / 1000
}
