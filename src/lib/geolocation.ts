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
//
// 位置情報ソース (LocationSource):
//   'browser'     — Web ブラウザの navigator.geolocation (Capacitor Web 実装)
//   'android_gps' — ネイティブ Android LocationManager
//                   (Mock GPS 経由で 外部 RTK 受信機 = Drogger 等 も接続可)
//   'drogger'     — ネイティブ側で Drogger を BT SPP 直接接続 (未実装)
//
// Step 1: 骨組みだけ。既定は プラットフォーム判定に基づく:
//   Web → 'browser'  /  ネイティブ → 'android_gps' (現行動作)
// Drogger ネイティブプラグインの実装完了後、ネイティブ既定を 'drogger' に切替。
// 開発時は URL クエリ ?locationSource=... で強制上書き可。

import { Geolocation, type Position } from '@capacitor/geolocation'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { isMobilityApp } from './appVariant'

export type LocationSource = 'browser' | 'android_gps' | 'drogger'

/**
 * 現在利用すべき位置情報ソースを決定する。
 *  1) URL クエリ `?locationSource=browser|android_gps|drogger` があれば それを採用
 *     (開発 / QA で 別ソースをテストしたい 等)
 *  2) それ以外は プラットフォーム × アプリバリアント の既定:
 *     - Web ブラウザ:           'browser'  (navigator.geolocation)
 *     - ネイティブ + ICT APK:   'drogger'  (BT SPP 直接受信 / android-ict/ に
 *                                          DroggerLocationPlugin を登録済み)
 *     - ネイティブ + Mobility APK: 'android_gps' (Drogger プラグイン未登録なので
 *                                          Web モックへフォールバックしないよう
 *                                          android_gps を明示)
 */
export function getActiveSource(): LocationSource {
  if (typeof window !== 'undefined') {
    try {
      const q = new URLSearchParams(window.location.search).get('locationSource')
      if (q === 'browser' || q === 'android_gps' || q === 'drogger') return q
    } catch {
      /* URL パース失敗は無視 */
    }
  }
  if (!Capacitor.isNativePlatform()) return 'browser'
  // ネイティブ: mobility APK なら Android GPS、ICT APK なら Drogger
  if (isMobilityApp()) return 'android_gps'
  return 'drogger'
}


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
  /** 水平精度 (メートル)。Drogger は GST の std dev から計算、Web は Position.coords.accuracy */
  accuracy_m: number | null
  /** 垂直精度 (メートル)。Drogger は GST の std_alt、Web は Position.coords.altitudeAccuracy */
  altitude_accuracy_m: number | null
  speed_kmh: number | null
  heading_deg: number | null
  /** NMEA GGA field 9 = 受信機内蔵ジオイド (通常 EGM96) 基準の MSL 標高 [m]
   *  ブラウザ / Android GPS では 通常 楕円体高 (WGS84) */
  altitude_m: number | null
  recorded_at: string
  /** NMEA GGA Fix Quality (Drogger のみ)。4=RTK Fix, 5=RTK Float, 2=DGPS, 1=SPS, 0=No Fix.
   *  ブラウザ / Android GPS の場合は null (受信機側で判定できない) */
  fixQuality?: number | null
  /** NMEA GGA field 11 = 受信機内蔵ジオイド と WGS84 楕円体 の差 [m] (Drogger のみ)。
   *  altitude_m + geoidal_separation_m = 楕円体高。
   *  JPGEO2024 で 補正する時は 楕円体高 に 変換してから 引く。
   *  ブラウザ / Android GPS では null (altitude_m が 既に 楕円体高 の 想定) */
  geoidal_separation_m?: number | null
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
    altitude_accuracy_m: c.altitudeAccuracy ?? null,
    // Capacitor は speed を m/s で返す (Web と同じ)
    speed_kmh: c.speed != null ? c.speed * 3.6 : null,
    heading_deg: c.heading ?? null,
    altitude_m: c.altitude ?? null,
    recorded_at: new Date(p.timestamp).toISOString(),
    fixQuality: null,
    geoidal_separation_m: null,
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
  const source = getActiveSource()
  if (source === 'drogger') {
    // 動的 import で 循環依存を回避 (drogger.ts が geolocation.ts の型を import)
    const { getDroggerSample } = await import('./drogger')
    return getDroggerSample(options?.timeout ?? 10000)
  }
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
    /**
     * 取得元を 明示指定する。省略時は getActiveSource() の 自動判定。
     * ICT ネイティブは 既定が 'drogger' なので、受信機が 繋がっていない間の
     * 端末内蔵 GPS フォールバックには 'browser' を 明示して使う。
     */
    source?: LocationSource
  },
): Promise<{ clear: () => void }> {
  const source = options?.source ?? getActiveSource()
  if (source === 'drogger') {
    const { watchDroggerSamples } = await import('./drogger')
    const handle = await watchDroggerSamples(callback)
    return { clear: () => { void handle.clear() } }
  }
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
    altitude_accuracy_m: loc.altitudeAccuracy ?? null,
    // BG plugin の speed は m/s
    speed_kmh: loc.speed != null ? loc.speed * 3.6 : null,
    heading_deg: loc.bearing ?? null,
    altitude_m: loc.altitude ?? null,
    recorded_at: new Date(loc.time).toISOString(),
    fixQuality: null,
    geoidal_separation_m: null,
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
  const source = getActiveSource()
  // Drogger は BT SPP 接続前提で バックグラウンド継続には ネイティブ側で
  // Foreground Service を実装する必要がある (Step 2 では未対応)。
  // 暫定的に フォアグラウンド watch (watchDroggerSamples) にフォールバック。
  if (source === 'drogger') {
    const { watchDroggerSamples } = await import('./drogger')
    const handle = await watchDroggerSamples(callback)
    return { clear: () => handle.clear() }
  }
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
