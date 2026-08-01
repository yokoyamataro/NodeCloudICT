// 緯度経度の 2 点間距離 (Haversine)。
// 誤差数 % 程度の球面近似だが、車両の走行距離計算には十分。

const EARTH_RADIUS_M = 6371008.8 // WGS84 平均半径 (m)

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * 起点 → 終点 の初期方位を度で返す (北=0、東=90、南=180、西=270)。
 * 球面近似 (Haversine と同じ精度)。
 */
export function bearingDeg(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const lat1 = toRad(from.lat)
  const lat2 = toRad(to.lat)
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/** 方位角を「北 / 北東 / 東 / 南東 / 南 / 南西 / 西 / 北西」に丸めた日本語ラベル */
export function bearingLabel(deg: number): string {
  const labels = ['北', '北東', '東', '南東', '南', '南西', '西', '北西']
  const idx = Math.round(deg / 45) % 8
  return labels[idx]
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
    /**
     * この精度より悪い (accuracy_m がこの値より大きい) 点は捨てる。既定 150m。
     * 屋内・車内・トンネル出口直後などで一時的に精度が悪くなるサンプルまで
     * 落とすと走行距離がゼロになりがちなので、既定は緩めに。
     */
    maxAccuracyM?: number
    /**
     * 隣接点間の距離がこの値より小さい場合はノイズとみなす。既定 1m。
     * background-geolocation 側で distanceFilter=1m を掛けているので、
     * ここで大きくフィルタする必要はもうない。
     */
    minSegmentM?: number
    /**
     * 隣接点間の距離がこの値より大きい場合は瞬間ジャンプとみなして捨てる。既定 2000m。
     * 高速道路 120km/h × ping 間隔 30 秒 で 1000m 進む想定 + オフライン
     * 復帰の飛びを許容して 2000m まで許す。それ超えは GPS 誤検知とみなす。
     */
    maxSegmentM?: number
  },
): number {
  const maxAccuracy = options?.maxAccuracyM ?? 150
  const minSegment = options?.minSegmentM ?? 1
  const maxSegment = options?.maxSegmentM ?? 2000

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
