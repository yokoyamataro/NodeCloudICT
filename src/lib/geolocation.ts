// 位置情報取得の薄いラッパ。
//
// なぜラップするか:
//   ・@capacitor/geolocation はブラウザ/ネイティブ両方に自動でフォールバック
//     するので、直接呼んでもほぼ動く。ただし呼び側で毎回 (id, position, err)
//     の3 引数を扱うより、単一化した send-position-getter があると差替が楽
//   ・将来 4-e 後半で background-geolocation を導入するときも、ここに
//     `useBackground: true` オプションだけ足せば呼び側は変えなくて済む
//
// 参考: https://capacitorjs.com/docs/apis/geolocation

import { Geolocation, type Position } from '@capacitor/geolocation'

export interface GeoSample {
  lat: number
  lon: number
  accuracy_m: number | null
  speed_kmh: number | null
  heading_deg: number | null
  altitude_m: number | null
  recorded_at: string
}

export type GeoErrorCode = 'permission_denied' | 'position_unavailable' | 'timeout' | 'unknown'

export interface GeoError {
  code: GeoErrorCode
  message: string
}

function normalizePosition(p: Position): GeoSample {
  const c = p.coords
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy_m: c.accuracy ?? null,
    // Capacitor は speed を m/s で返す (Web と同じ)
    speed_kmh: c.speed != null ? c.speed * 3.6 : null,
    heading_deg: c.heading ?? null,
    altitude_m: c.altitude ?? null,
    recorded_at: new Date(p.timestamp).toISOString(),
  }
}

function normalizeError(err: unknown): GeoError {
  const anyErr = err as { code?: number; message?: string } | null
  const msg = anyErr?.message ?? '位置情報の取得に失敗しました'
  const code = anyErr?.code
  if (code === 1) return { code: 'permission_denied', message: '位置情報の許可が必要です' }
  if (code === 2) return { code: 'position_unavailable', message: '位置情報を取得できません' }
  if (code === 3) return { code: 'timeout', message: 'タイムアウトしました' }
  // Capacitor ネイティブ側は文字列で "Location permission not granted" 等を返すことがある
  if (msg.toLowerCase().includes('permission'))
    return { code: 'permission_denied', message: '位置情報の許可が必要です' }
  return { code: 'unknown', message: msg }
}

/** 権限を確認し、必要なら要求する。ユーザーが拒否したら PermissionDenied を throw */
export async function ensureGeoPermission(): Promise<void> {
  try {
    const cur = await Geolocation.checkPermissions()
    if (cur.location === 'granted') return
    const req = await Geolocation.requestPermissions({ permissions: ['location'] })
    if (req.location !== 'granted') {
      throw { code: 1, message: 'permission not granted' }
    }
  } catch (err) {
    throw normalizeError(err)
  }
}

/** 1 発だけ現在地を取得 */
export async function getCurrentSample(options?: {
  enableHighAccuracy?: boolean
  timeout?: number
  maximumAge?: number
}): Promise<GeoSample> {
  await ensureGeoPermission()
  try {
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: options?.enableHighAccuracy ?? true,
      timeout: options?.timeout ?? 10000,
      maximumAge: options?.maximumAge ?? 0,
    })
    return normalizePosition(pos)
  } catch (err) {
    throw normalizeError(err)
  }
}

/** 継続監視。callback は positioning 通知/エラーの両方を担う。返り値は clear 用 handle */
export async function watchSamples(
  callback: (sample: GeoSample | null, err: GeoError | null) => void,
  options?: {
    enableHighAccuracy?: boolean
    timeout?: number
    maximumAge?: number
  },
): Promise<{ clear: () => void }> {
  await ensureGeoPermission()
  const watchId = await Geolocation.watchPosition(
    {
      enableHighAccuracy: options?.enableHighAccuracy ?? true,
      timeout: options?.timeout ?? 15000,
      maximumAge: options?.maximumAge ?? 5000,
    },
    (position, err) => {
      if (err) callback(null, normalizeError(err))
      else if (position) callback(normalizePosition(position), null)
    },
  )
  return {
    clear: () => {
      void Geolocation.clearWatch({ id: watchId })
    },
  }
}
