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

/** NTRIP キャスター設定 */
export interface NtripConfig {
  host: string
  port: number
  mountpoint: string
  user: string
  pass: string
  /** VRS (電子基準点/民間サービス) 系は true 必須 */
  sendGga: boolean
}

/** NTRIP 接続状態 */
export interface NtripStatus {
  connected: boolean
  host: string | null
  mountpoint: string | null
  bytesReceived: number
  /** 最後に RTCM を受信した epoch ms (0 なら未受信) */
  lastRtcmAt: number
}

/** SourceTable エントリ (STR; 行) */
export interface NtripMountpoint {
  mountpoint: string
  identifier: string
  format: string
  navSystem: string
  country: string
  nmeaRequired: boolean
  auth: string
  fee: string
}

/** 衛星コンステレーション */
export type Constellation =
  | 'GPS'
  | 'GLONASS'
  | 'Galileo'
  | 'BeiDou'
  | 'QZSS'
  | 'SBAS'
  | 'Multi'
  | 'Other'

/** GSV/GSA から復元した 衛星情報 (スカイマップ表示用) */
export interface SatelliteInfo {
  constellation: Constellation
  /** 衛星番号 (PRN) */
  prn: number
  /** 仰角 [deg] 0-90 */
  elevation: number | null
  /** 方位角 [deg] 0-360 (北から時計回り) */
  azimuth: number | null
  /** 信号強度 [dB-Hz] 0-99 */
  snr: number | null
  /** Fix 計算に使用中か (GSA 由来) */
  usedInFix: boolean
}

export interface SatellitesSnapshot {
  satellites: SatelliteInfo[]
  timestamp: number
}

/** GNSS 受信機からの 姿勢情報 (heading/pitch/roll) */
export interface AttitudeInfo {
  /** 方位 [deg] 0-360, 北=0, 時計回り */
  heading: number | null
  /** ピッチ (前傾) [deg] */
  pitch: number | null
  /** ロール (横傾) [deg] */
  roll: number | null
  /** 情報源: 'PSAT/HPR' | 'HDT' | 'RMC (COG)' | null */
  source: string | null
  timestamp: number
}

/** ネイティブプラグインが 公開する予定の JS 側 API 契約 (完全一致で実装する) */
interface DroggerLocationPlugin {
  start(options?: { deviceAddress?: string }): Promise<void>
  stop(): Promise<void>
  getStatus(): Promise<{ connected: boolean; deviceName: string | null }>
  listPairedDevices(): Promise<{ devices: { name: string; address: string }[] }>
  // ---- NTRIP ----
  startNtrip(config: NtripConfig): Promise<void>
  stopNtrip(): Promise<void>
  getNtripStatus(): Promise<NtripStatus>
  fetchNtripSourceTable(options: {
    host: string
    port: number
    user?: string
    pass?: string
  }): Promise<{ mountpoints: NtripMountpoint[]; raw: string }>
  getSatellites(): Promise<SatellitesSnapshot>
  getAttitude(): Promise<AttitudeInfo>
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
  addListener(
    eventName: 'ntripStatusChange',
    listener: (ev: NtripStatus) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'satellites',
    listener: (ev: SatellitesSnapshot) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'attitude',
    listener: (ev: AttitudeInfo) => void,
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
    ntripStatusChange: Array<(ev: NtripStatus) => void>
    satellites: Array<(ev: SatellitesSnapshot) => void>
    attitude: Array<(ev: AttitudeInfo) => void>
  }
  connected: boolean
  base: { lat: number; lng: number }
  /** NTRIP 疑似接続状態 (Web モックでは 実際に TCP 接続はしない) */
  ntrip: NtripStatus
}

const webMockState: WebMockState = {
  timer: null,
  listeners: {
    location: [],
    error: [],
    statusChange: [],
    ntripStatusChange: [],
    satellites: [],
    attitude: [],
  },
  connected: false,
  base: { ...WEB_MOCK_BASE },
  ntrip: {
    connected: false,
    host: null,
    mountpoint: null,
    bytesReceived: 0,
    lastRtcmAt: 0,
  },
}

// Web モック用: ダミー衛星スナップショット (スカイマップ表示テスト用)
function makeMockSatellites(): SatellitesSnapshot {
  const sats: SatelliteInfo[] = [
    // GPS
    { constellation: 'GPS', prn: 5, elevation: 65, azimuth: 210, snr: 47, usedInFix: true },
    { constellation: 'GPS', prn: 13, elevation: 42, azimuth: 45, snr: 44, usedInFix: true },
    { constellation: 'GPS', prn: 15, elevation: 25, azimuth: 315, snr: 38, usedInFix: true },
    { constellation: 'GPS', prn: 20, elevation: 78, azimuth: 130, snr: 49, usedInFix: true },
    { constellation: 'GPS', prn: 29, elevation: 12, azimuth: 285, snr: 28, usedInFix: false },
    // GLONASS
    { constellation: 'GLONASS', prn: 73, elevation: 55, azimuth: 180, snr: 42, usedInFix: true },
    { constellation: 'GLONASS', prn: 74, elevation: 30, azimuth: 90, snr: 39, usedInFix: true },
    { constellation: 'GLONASS', prn: 83, elevation: 68, azimuth: 350, snr: 46, usedInFix: true },
    // Galileo
    { constellation: 'Galileo', prn: 311, elevation: 50, azimuth: 60, snr: 45, usedInFix: true },
    { constellation: 'Galileo', prn: 319, elevation: 22, azimuth: 240, snr: 33, usedInFix: false },
    // QZSS (みちびき)
    { constellation: 'QZSS', prn: 194, elevation: 72, azimuth: 165, snr: 48, usedInFix: true },
    // BeiDou
    { constellation: 'BeiDou', prn: 208, elevation: 15, azimuth: 120, snr: 31, usedInFix: false },
    { constellation: 'BeiDou', prn: 220, elevation: 45, azimuth: 200, snr: 40, usedInFix: true },
  ]
  return { satellites: sats, timestamp: Date.now() }
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
        accuracy_m: 0.015, // RTK Fix 想定 (水平)
        altitude_accuracy_m: 0.025, // RTK Fix 想定 (垂直、水平の 1.5〜2 倍が典型)
        speed_kmh: 0,
        heading_deg: null,
        altitude_m: 20 + Math.sin(tick * 0.05) * 0.02, // 受信機内蔵ジオイド 基準の MSL
        geoidal_separation_m: 26.5, // Web モック: 網走近郊の geoid sep (Drogger 実測値相当)
        recorded_at: new Date().toISOString(),
        fixQuality: 4, // RTK Fix
        hdop: 0.7,
        satellites: 18,
      }
      for (const l of webMockState.listeners.location) l(sample)
      // 5 秒毎に 衛星スナップショットも emit (スカイマップ動作確認用)
      if (tick % 5 === 0) {
        const snap = makeMockSatellites()
        for (const l of webMockState.listeners.satellites) l(snap)
      }
      // 姿勢 (heading をゆっくり回転させる ダミー)
      const att: AttitudeInfo = {
        heading: (tick * 5) % 360,
        pitch: Math.sin(tick * 0.3) * 3,
        roll: Math.cos(tick * 0.2) * 2,
        source: 'PSAT/HPR',
        timestamp: Date.now(),
      }
      for (const l of webMockState.listeners.attitude) l(att)
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
  // ---- NTRIP: Web では 実 TCP 接続をせず 疑似接続表示のみ ----
  async startNtrip(config) {
    webMockState.ntrip = {
      connected: true,
      host: config.host,
      mountpoint: config.mountpoint,
      bytesReceived: 0,
      lastRtcmAt: Date.now(),
    }
    for (const l of webMockState.listeners.ntripStatusChange) l(webMockState.ntrip)
  },
  async stopNtrip() {
    webMockState.ntrip = {
      connected: false,
      host: null,
      mountpoint: null,
      bytesReceived: 0,
      lastRtcmAt: 0,
    }
    for (const l of webMockState.listeners.ntripStatusChange) l(webMockState.ntrip)
  },
  async getNtripStatus() {
    return { ...webMockState.ntrip }
  },
  async fetchNtripSourceTable(_options) {
    // Web モックでは 実 TCP は張れないので空リストを返す
    void _options
    return { mountpoints: [], raw: '' }
  },
  async getSatellites() {
    return makeMockSatellites()
  },
  async getAttitude() {
    // Web モックでは 動的に変化する 疑似姿勢 (heading が ゆっくり回転)
    const t = Date.now() / 1000
    return {
      heading: (t * 5) % 360,
      pitch: Math.sin(t * 0.3) * 3,
      roll: Math.cos(t * 0.2) * 2,
      source: 'PSAT/HPR',
      timestamp: Date.now(),
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
    } else if (eventName === 'ntripStatusChange') {
      webMockState.listeners.ntripStatusChange.push(listener as (ev: NtripStatus) => void)
    } else if (eventName === 'satellites') {
      webMockState.listeners.satellites.push(listener as (ev: SatellitesSnapshot) => void)
    } else if (eventName === 'attitude') {
      webMockState.listeners.attitude.push(listener as (ev: AttitudeInfo) => void)
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
        } else if (eventName === 'ntripStatusChange') {
          const arr = webMockState.listeners.ntripStatusChange
          const i = arr.indexOf(listener as (ev: NtripStatus) => void)
          if (i >= 0) arr.splice(i, 1)
        } else if (eventName === 'satellites') {
          const arr = webMockState.listeners.satellites
          const i = arr.indexOf(listener as (ev: SatellitesSnapshot) => void)
          if (i >= 0) arr.splice(i, 1)
        } else if (eventName === 'attitude') {
          const arr = webMockState.listeners.attitude
          const i = arr.indexOf(listener as (ev: AttitudeInfo) => void)
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

// ============================================================================
// NTRIP ラッパ (ネイティブプラグイン経由)
// ============================================================================

/** NTRIP キャスターに 接続開始。RTCM3 は 自動的に Drogger BT SPP へ流し込まれる */
export async function startNtrip(config: NtripConfig): Promise<void> {
  await DroggerLocation.startNtrip(config)
}

export async function stopNtrip(): Promise<void> {
  await DroggerLocation.stopNtrip()
}

export async function getNtripStatus(): Promise<NtripStatus> {
  return DroggerLocation.getNtripStatus()
}

/** SourceTable を fetch して 利用可能な mountpoint 一覧を返す */
export async function fetchNtripSourceTable(options: {
  host: string
  port: number
  user?: string
  pass?: string
}): Promise<{ mountpoints: NtripMountpoint[]; raw: string }> {
  return DroggerLocation.fetchNtripSourceTable(options)
}

/** 現在の 衛星スナップショット (スカイマップ用) */
export async function getSatellites(): Promise<SatellitesSnapshot> {
  return DroggerLocation.getSatellites()
}

/** 現在の 姿勢情報 (heading/pitch/roll) */
export async function getAttitude(): Promise<AttitudeInfo> {
  return DroggerLocation.getAttitude()
}
