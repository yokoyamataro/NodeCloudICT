// 位置情報取得の薄いラッパ。
//
// 3 種類の API:
//   getCurrentSample()          — 1 発だけ (@capacitor/geolocation)
//   watchSamples()              — フォアグラウンド連続 (@capacitor/geolocation)
//   watchSamplesInBackground()  — バックグラウンド継続追跡
//                                 (@capacitor-community/background-geolocation)
//
// 参考:
//   https://capacitorjs.com/docs/apis/geolocation
//   https://github.com/capacitor-community/background-geolocation

import { Geolocation, type Position } from '@capacitor/geolocation'
import { Capacitor, registerPlugin } from '@capacitor/core'

// バックグラウンド追跡プラグイン。@capacitor-community/background-geolocation は
// registerPlugin ベースの薄い型を提供している。呼び出し側では
// addWatcher で開始し、removeWatcher で停止する。
interface BgLocation {
  latitude: number
  longitude: number
  accuracy: number
  altitude: number | null
  altitudeAccuracy: number | null
  simulated: boolean
  speed: number | null
  bearing: number | null
  time: number
}

interface BgWatcherOptions {
  /** true にすると Android で foreground service 起動 + 常駐通知を出す */
  backgroundMessage?: string
  /** 通知タイトル (Android のみ) */
  backgroundTitle?: string
  /** 初回のパーミッションダイアログを出すか */
  requestPermissions?: boolean
  /** 古いキャッシュ位置を許すか (通常 false) */
  stale?: boolean
  /** 移動距離が N メートル以上変わった時のみ通知 */
  distanceFilter?: number
}

interface BackgroundGeolocationPlugin {
  addWatcher(
    options: BgWatcherOptions,
    callback: (location?: BgLocation, error?: { code: string; message: string }) => void,
  ): Promise<string>
  removeWatcher(options: { id: string }): Promise<void>
  openSettings(): Promise<void>
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>(
  'BackgroundGeolocation',
)

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
  // Web は checkPermissions が navigator.permissions API に依存しており、
  // 一部モバイルブラウザで throw する。navigator.geolocation.watchPosition
  // 自体はブラウザが自動的に権限プロンプトを出すため、事前チェックは不要。
  // ネイティブ (iOS/Android) のみ明示的にリクエストする。
  if (typeof window !== 'undefined' && !Capacitor.isNativePlatform()) return
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

// ============================================================================
// バックグラウンド継続追跡 (Capacitor Community plugin)
// ============================================================================

function normalizeBgLocation(loc: BgLocation): GeoSample {
  return {
    lat: loc.latitude,
    lon: loc.longitude,
    accuracy_m: loc.accuracy ?? null,
    // BG plugin の speed は m/s
    speed_kmh: loc.speed != null ? loc.speed * 3.6 : null,
    heading_deg: loc.bearing ?? null,
    altitude_m: loc.altitude ?? null,
    recorded_at: new Date(loc.time).toISOString(),
  }
}

/** true ならブラウザ (Capacitor ネイティブでない) */
export function isWebPlatform(): boolean {
  return !Capacitor.isNativePlatform()
}

/**
 * バックグラウンドで位置を追跡し続ける。
 *   Android: Foreground service + 通知が常駐 (アプリを閉じても継続)
 *   iOS:     Background modes = location updates が有効ならバックグラウンド継続
 *   Web:     background-geolocation プラグインは Web 実装が無いため、
 *            フォアグラウンドの watchSamples にフォールバック
 *            (バックグラウンド継続はできない)
 *
 * @param callback 位置 or エラー通知
 * @param options.notificationTitle / .notificationBody Android 通知の表示
 * @param options.distanceFilter 位置更新の距離しきい値 (メートル)
 * @returns clear() で停止するハンドル
 */
export async function watchSamplesInBackground(
  callback: (sample: GeoSample | null, err: GeoError | null) => void,
  options?: {
    notificationTitle?: string
    notificationBody?: string
    distanceFilter?: number
  },
): Promise<{ clear: () => Promise<void> }> {
  // Web ではネイティブプラグイン未対応。フォアグラウンド watch にフォールバック
  // することで、モバイルブラウザでのテスト時にも位置送信が継続する。
  if (isWebPlatform()) {
    const handle = await watchSamples(callback, { enableHighAccuracy: true })
    return { clear: async () => handle.clear() }
  }
  const watcherId = await BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: options?.notificationTitle ?? 'NodeCloudモビリティ',
      backgroundMessage: options?.notificationBody ?? '現在地を送信中',
      requestPermissions: true,
      stale: false,
      distanceFilter: options?.distanceFilter ?? 5,
    },
    (location, error) => {
      if (error) {
        // BG plugin のエラーコード: 'NOT_AUTHORIZED' | 'NOT_ENABLED' | 'PERMISSION_DENIED' ...
        const code = (error.code || '').toUpperCase()
        const mapped: GeoErrorCode = code.includes('PERMISSION') || code.includes('AUTHORIZED')
          ? 'permission_denied'
          : code.includes('ENABLED')
            ? 'position_unavailable'
            : 'unknown'
        callback(null, { code: mapped, message: error.message })
        return
      }
      if (location) callback(normalizeBgLocation(location), null)
    },
  )
  return {
    clear: async () => {
      await BackgroundGeolocation.removeWatcher({ id: watcherId })
    },
  }
}

/** バックグラウンド追跡の権限拒否時に OS 設定画面を開く (ユーザー案内用) */
export async function openLocationSettings(): Promise<void> {
  try {
    await BackgroundGeolocation.openSettings()
  } catch {
    // web / 非対応環境では何もしない
  }
}
