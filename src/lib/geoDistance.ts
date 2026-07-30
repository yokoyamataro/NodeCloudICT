// 緯度経度の 2 点間距離 (Haversine)。
// 誤差数 % 程度の球面近似だが、車両の走行距離計算には十分。

const EARTH_RADIUS_M = 6371008.8 // WGS84 平均半径 (m)

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 2 点間の大圏距離をメートルで返す */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s1 = Math.sin(dLat / 2)
  const s2 = Math.sin(dLon / 2)
  const c =
    s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(c)))
}

/**
 * 位置の系列から累積走行距離を計算する。
 *   points は時刻昇順 (古い→新しい) 前提。
 *   accuracy_m が悪すぎる点や、直後の点との間隔が短すぎる/長すぎる点は
 *   ノイズとみなして除外する。
 */
export function computeTotalDistanceMeters(
  points: Array<{
    lat: number
    lon: number
    accuracy_m: number | null
    recorded_at: string
  }>,
  options?: {
    /** この精度より悪い (accuracy_m がこの値より大きい) 点は捨てる。既定 50m */
    maxAccuracyM?: number
    /** 隣接点間の距離がこの値より小さい場合はノイズとみなす。既定 5m */
    minSegmentM?: number
    /** 隣接点間の距離がこの値より大きい場合は瞬間ジャンプとみなして捨てる。既定 500m */
    maxSegmentM?: number
  },
): number {
  const maxAccuracy = options?.maxAccuracyM ?? 50
  const minSegment = options?.minSegmentM ?? 5
  const maxSegment = options?.maxSegmentM ?? 500

  const filtered = points.filter(
    (p) => p.accuracy_m == null || p.accuracy_m <= maxAccuracy,
  )
  let total = 0
  for (let i = 1; i < filtered.length; i++) {
    const seg = haversineMeters(filtered[i - 1], filtered[i])
    if (seg < minSegment || seg > maxSegment) continue
    total += seg
  }
  return total
}
