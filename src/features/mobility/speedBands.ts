// 走行スピードの 色分けと 区間分割。
//
// 管理画面 (FleetMapView) と ドライバー画面 (MobilityDriverPage) の 両方が 使う。
// エントリを 分けた あと、ドライバー側が これを FleetMapView から import すると
// 管理画面の 地図本体が まるごと ドライバー用バンドルに 入ってしまうため、
// 依存の 軽い ここに 切り出している。

import { haversineMeters } from '@/lib/geoDistance'
import type { MobilityPosition } from '@/types/database'

// 走行スピード可視化用のカラー階段。
// 0-5: 灰(停止) / 5-20: 青 / 20-40: 緑 / 40-60: 黄 / 60-80: 橙 / 80+: 赤
export const SPEED_BANDS: Array<{ min: number; label: string; color: string }> = [
  { min: 0, label: '0-5', color: '#94a3b8' },
  { min: 5, label: '5-20', color: '#3b82f6' },
  { min: 20, label: '20-40', color: '#22c55e' },
  { min: 40, label: '40-60', color: '#eab308' },
  { min: 60, label: '60-80', color: '#f97316' },
  { min: 80, label: '80+', color: '#ef4444' },
]

function speedColor(kmh: number): string {
  let found = SPEED_BANDS[0].color
  for (const b of SPEED_BANDS) {
    if (kmh >= b.min) found = b.color
  }
  return found
}

// 2 点間の平均スピード km/h。ping の speed_kmh を優先し、無ければ距離÷時間で推定。
function segmentSpeedKmh(a: MobilityPosition, b: MobilityPosition): number {
  const sa = a.speed_kmh
  const sb = b.speed_kmh
  if (sa != null && sa >= 0 && sb != null && sb >= 0) return (sa + sb) / 2
  if (sa != null && sa >= 0) return sa
  if (sb != null && sb >= 0) return sb
  // fallback: 距離 / 時間
  const dist = haversineMeters({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon })
  const dt = new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
  if (dt <= 0) return 0
  return (dist / (dt / 1000)) * 3.6
}

// 位置列を「同一色の連続区間」でまとめて返す。1 セクションが数千点あっても
// polyline 数を減らせるので Leaflet の負荷を抑えられる。
export function speedSegments(
  points: MobilityPosition[],
): Array<{ color: string; positions: [number, number][] }> {
  const out: Array<{ color: string; positions: [number, number][] }> = []
  if (points.length < 2) return out
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const speed = segmentSpeedKmh(p1, p2)
    const color = speedColor(speed)
    const last = out[out.length - 1]
    if (last && last.color === color) {
      last.positions.push([p2.lat, p2.lon])
    } else {
      out.push({
        color,
        positions: [
          [p1.lat, p1.lon],
          [p2.lat, p2.lon],
        ],
      })
    }
  }
  return out
}
