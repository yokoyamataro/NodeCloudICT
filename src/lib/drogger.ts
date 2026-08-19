// Drogger (RTK GNSS 受信機) BT SPP 直接受信の TS 側 wrapper。
//
// ネイティブ側 (Kotlin) の Capacitor プラグインが 未実装のため、Web / 未実装環境では
// ダミーの GNSS サンプルを流して TS パイプライン (geolocation.ts → 各画面) を
// エンドツーエンドでテストできるようにする。
//
// ネイティブプラグインが完成した後は 以下のインターフェースを実装すれば
// この wrapper が自動的にネイティブ経由に切り替わる:
//
//   plugin name: 'DroggerLocation'
//   methods:
//     start(options?: { deviceAddress?: string }): Promise<void>
//     stop(): Promise<void>
//     getStatus(): Promise<{ connected: boolean; deviceName: string | null }>
//     listPairedDevices(): Promise<{ devices: { name: string; address: string }[] }>
//   events (addListener):
//     'location'     — DroggerLocationEvent (NMEA GGA/RMC を JS 型に正規化)
//     'error'        — { code: string; message: string }
//     'statusChange' — { connected: boolean; deviceName: string | null }

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { GeoSample, GeoError } from './geolocation'

/** NMEA GGA の Fix Quality (数値定義)。0=NoFix / 1=GPS / 2=DGPS / 4=RTK Fix / 5=RTK Float */
export type DroggerFixQuality = 0 | 1 | 2 | 4 | 5

/** Drogger からの 位置サンプル。geolocation.ts の GeoSample を拡張し RTK メタを添える */
export interface DroggerLocationEvent extends GeoSample {
  /** NMEA GGA Fix Quality */
  fixQuality: DroggerFixQuality | null
  /** HDOP (水平精度低下率) */
  hdop: number | null
  /** 使用衛星数 */
  satellites: number | null
}

/** ネイティブプラグインが 公開する予定の JS 側 API 契約 (完全一致で実装する) */
interface DroggerLocationPlugin {
  start(options?: { deviceAddress?: string }): Promise<void>
  stop(): Promise<void>
  getStatus(): Promise<{ connected: boolean; deviceName: string | null }>
  listPairedDevices(): Promise<{ devices: { name: string; address: string }[] }>
  addListener(
    eventName: 'location',
    listener: (ev: DroggerLocationEvent) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'error',
    listener: (ev: GeoError) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'statusChange',
    listener: (ev: { connected: boolean; deviceName: string | null }) => void,
  ): Promise<PluginListenerHandle>
}

// ネイティブ実装が無い環境向けの Web モック。
// - start() で 1 Hz のタイマー起動、fixQuality=RTK Fix の 疑似 GGA を流す
// - stop() でタイマー停止
// - 初期位置: 札幌駅前 (35.6812, 139.7671 ではなく 北海道の測量アプリなので網走近郊)
//   工区に応じて動的にしたい場合は 呼出側が startWatchDrogger の base 引数で上書き可
const WEB_MOCK_BASE = { lat: 44.0201, lng: 144.2735 } // 網走市街周辺

interface WebMockState {
  timer: number | null
  listeners: {
    location: Array<(ev: DroggerLocationEvent) => void>
    error: Array<(ev: GeoError) => void>
    statusChange: Array<(ev: { connected: boolean; deviceName: string | null }) => void>
  }
  connected: boolean
  base: { lat: number; lng: number }
}

const webMockState: WebMockState = {
  timer: null,
  listeners: { location: [], error: [], statusChange: [] },
  connected: false,
  base: { ...WEB_MOCK_BASE },
}

const webMockPlugin: DroggerLocationPlugin = {
  async start(options) {
    // deviceAddress が渡されても Web は無視 (BT 接続シミュレーションのみ)
    void options
    if (webMockState.connected) return
    webMockState.connected = true
    for (const l of webMockState.listeners.statusChange) {
      l({ connected: true, deviceName: '(Web モック)' })
    }
    let tick = 0
    webMockState.timer = window.setInterval(() => {
      tick += 1
      // 微小に位置を動かす (±0.5m 相当)
      const dLat = Math.sin(tick * 0.1) * 0.000005
      const dLng = Math.cos(tick * 0.1) * 0.000005
      const sample: DroggerLocationEvent = {
        lat: webMockState.base.lat + dLat,
        lon: webMockState.base.lng + dLng,
        accuracy_m: 0.015, // RTK Fix 想定
        speed_kmh: 0,
        heading_deg: null,
        altitude_m: 20 + Math.sin(tick * 0.05) * 0.02,
        recorded_at: new Date().toISOString(),
        fixQuality: 4, // RTK Fix
        hdop: 0.7,
        satellites: 18,
      }
      for (const l of webMockState.listeners.location) l(sample)
    }, 1000)
  },
  async stop() {
    if (webMockState.timer != null) {
      window.clearInterval(webMockState.timer)
      webMockState.timer = null
    }
    if (webMockState.connected) {
      webMockState.connected = false
      for (const l of webMockState.listeners.statusChange) {
        l({ connected: false, deviceName: null })
      }
    }
  },
  async getStatus() {
    return {
      connected: webMockState.connected,
      deviceName: webMockState.connected ? '(Web モック)' : null,
    }
  },
  async listPairedDevices() {
    return {
      devices: [{ name: 'Drogger-DG-PRO1 (Web モック)', address: '00:00:00:00:00:00' }],
    }
  },
  addListener(eventName, listener) {
    // 型ガード: eventName で listener の型が変わる (overload)
    if (eventName === 'location') {
      webMockState.listeners.location.push(listener as (ev: DroggerLocationEvent) => void)
    } else if (eventName === 'error') {
      webMockState.listeners.error.push(listener as (ev: GeoError) => void)
    } else if (eventName === 'statusChange') {
      webMockState.listeners.statusChange.push(
        listener as (ev: { connected: boolean; deviceName: string | null }) => void,
      )
    }
    const handle: PluginListenerHandle = {
      remove: async () => {
        if (eventName === 'location') {
          const arr = webMockState.listeners.location
          const i = arr.indexOf(listener as (ev: DroggerLocationEvent) => void)
          if (i >= 0) arr.splice(i, 1)
        } else if (eventName === 'error') {
          const arr = webMockState.listeners.error
          const i = arr.indexOf(listener as (ev: GeoError) => void)
          if (i >= 0) arr.splice(i, 1)
        } else if (eventName === 'statusChange') {
          const arr = webMockState.listeners.statusChange
          const i = arr.indexOf(
            listener as (ev: { connected: boolean; deviceName: string | null }) => void,
          )
          if (i >= 0) arr.splice(i, 1)
        }
      },
    }
    return Promise.resolve(handle)
  },
}

// registerPlugin は ネイティブ実装が存在すれば ネイティブ経由、無ければ Web 実装に fallback
// する。ここでは Web 実装を明示的に指定して、ネイティブ プラグインが未実装の間も
// Web (と ネイティブ) で 常にモックが使えるようにする。
//
// ネイティブ Kotlin プラグイン (DroggerLocationPlugin) 実装後は、Native platform
// では registerPlugin が ネイティブ実装を優先するため 自動的に切り替わる。
export const DroggerLocation = registerPlugin<DroggerLocationPlugin>('DroggerLocation', {
  web: webMockPlugin,
  // android: 未指定 = ネイティブ実装があれば それを使う / 無ければ web fallback
})

/**
 * geolocation.ts の watchSamples 風 API を Drogger 側にも提供。
 * source='drogger' の時に geolocation.ts から呼ばれる想定。
 *
 * @param callback 位置 or エラー通知
 * @param options.base Web モック時の基準座標 (省略時は 網走市街)
 */
export async function watchDroggerSamples(
  callback: (sample: DroggerLocationEvent | null, err: GeoError | null) => void,
  options?: { base?: { lat: number; lng: number } },
): Promise<{ clear: () => Promise<void> }> {
  if (options?.base && !Capacitor.isNativePlatform()) {
    webMockState.base = { ...options.base }
  }
  const locHandle = await DroggerLocation.addListener('location', (ev) => callback(ev, null))
  const errHandle = await DroggerLocation.addListener('error', (err) => callback(null, err))
  await DroggerLocation.start()
  return {
    clear: async () => {
      await DroggerLocation.stop()
      await locHandle.remove()
      await errHandle.remove()
    },
  }
}

/**
 * 1 発だけ Drogger から 位置を取得する。イベント購読を短時間だけ張って
 * 最初の 1 サンプルを取ったら 自動で解除する。
 * タイムアウト (既定 10 秒) 内にサンプルが来なければ position_unavailable を throw。
 */
export async function getDroggerSample(timeoutMs = 10000): Promise<DroggerLocationEvent> {
  return new Promise((resolve, reject) => {
    let done = false
    let handle: PluginListenerHandle | null = null
    const timer = window.setTimeout(async () => {
      if (done) return
      done = true
      if (handle) await handle.remove()
      await DroggerLocation.stop().catch(() => undefined)
      reject({
        code: 'timeout',
        message: `Drogger からの位置取得がタイムアウトしました (${timeoutMs}ms)`,
      } satisfies GeoError)
    }, timeoutMs)
    DroggerLocation.addListener('location', async (ev) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      if (handle) await handle.remove()
      await DroggerLocation.stop().catch(() => undefined)
      resolve(ev)
    })
      .then((h) => {
        handle = h
        return DroggerLocation.start()
      })
      .catch((err) => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        reject(err)
      })
  })
}

/** Drogger 接続状態 */
export async function getDroggerStatus(): Promise<{ connected: boolean; deviceName: string | null }> {
  return DroggerLocation.getStatus()
}

/** ペアリング済み BT デバイスから Drogger 候補を列挙 (Web モックはダミー 1 件を返す) */
export async function listPairedDroggerDevices(): Promise<{ name: string; address: string }[]> {
  const r = await DroggerLocation.listPairedDevices()
  return r.devices
}

/** Drogger 系デバイスの名前パターン (Kotlin 側と揃える) */
const DROGGER_NAME_PATTERN =
  /^(drogger|dg[-_]|rzs)/i

/**
 * start() を まず 引数無しで試み、失敗した場合はペアリング済みから
 * Drogger 系デバイス (RZS.D01 / Drogger-XXX / DG-PRO1 等) を探して
 * deviceAddress 指定で再試行する。
 *
 * ネイティブ Kotlin 側の名前照合が古い APK ではまだ「Drogger」しか
 * 対応していない場合の フォールバック救済。
 */
export async function startWithAutoDetect(): Promise<void> {
  // 1st try: 名前無指定 (ネイティブ側の自動選択に任せる)
  try {
    await DroggerLocation.start()
    return
  } catch (err) {
    // continue to fallback
    console.warn('DroggerLocation.start() without address failed, trying address fallback:', err)
  }
  // 2nd try: ペアリング済みから Drogger 系を探して address 指定
  let devices: { name: string; address: string }[] = []
  try {
    const r = await DroggerLocation.listPairedDevices()
    devices = r.devices
  } catch (err) {
    throw err
  }
  const candidate = devices.find((d) => DROGGER_NAME_PATTERN.test(d.name || ''))
  if (!candidate) {
    throw {
      code: 'position_unavailable',
      message: 'Drogger 系のペアリング済みデバイスが 見つかりません',
    } as GeoError
  }
  await DroggerLocation.start({ deviceAddress: candidate.address })
}
