// Drogger BT SPP 接続の 全アプリ横断ライフサイクル管理。
//
// 従来は DroggerStatusBadge の useEffect 内で stop → start を していたため、
// 工区を 閉じて 別の工区に 移動する 度に BT が 切断→再接続 されていた。
// これを 廃し、モジュールレベル で 一度だけ start して、その後は listener を
// 保持したまま Zustand 状態を 更新し続ける。
//
// バッジは 表示専用に 徹し、reconnect / disconnect ボタンからのみ 明示的な
// stop/start が 走る。

import { create } from 'zustand'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  DroggerLocation,
  startWithAutoDetect,
  type DroggerFixQuality,
  type DroggerLocationEvent,
  type NtripStatus,
} from '@/lib/drogger'
import { getActiveSource } from '@/lib/geolocation'

const initialNtrip: NtripStatus = {
  connected: false,
  host: null,
  mountpoint: null,
  bytesReceived: 0,
  lastRtcmAt: 0,
}

interface DroggerConnectionState {
  connected: boolean
  deviceName: string | null
  fixQuality: DroggerFixQuality | null
  hdop: number | null
  satellites: number | null
  lastUpdateAt: number | null
  ntrip: NtripStatus
  lastErrorCode: string | null

  /** アプリ 起動後 1 回だけ 実行される 初期化 (idempotent)。
   *  source='drogger' の 時のみ listener 登録 + BT 自動接続。 */
  ensureStarted: () => Promise<void>
  /** 手動 stop → start */
  reconnect: () => Promise<void>
  /** BT SPP を 閉じる (ユーザー操作、NTRIP も 一緒に切れる) */
  disconnect: () => Promise<void>
}

// モジュールレベル: 初期化は 1 回だけ、listener は 常に 生きている
let _initialized = false
let _handles: PluginListenerHandle[] = []
let _startPromise: Promise<void> | null = null

export const useDroggerConnection = create<DroggerConnectionState>((set) => ({
  connected: false,
  deviceName: null,
  fixQuality: null,
  hdop: null,
  satellites: null,
  lastUpdateAt: null,
  ntrip: initialNtrip,
  lastErrorCode: null,

  ensureStarted: async () => {
    if (_initialized) return _startPromise ?? undefined
    if (getActiveSource() !== 'drogger') return
    _initialized = true
    _startPromise = (async () => {
      // 1. Listener 登録 (アプリ寿命の 間 生かす)
      const locH = await DroggerLocation.addListener('location', (ev: DroggerLocationEvent) => {
        set({
          fixQuality: ev.fixQuality,
          hdop: ev.hdop,
          satellites: ev.satellites,
          lastUpdateAt: Date.now(),
        })
      })
      const stH = await DroggerLocation.addListener('statusChange', (ev) => {
        set({ connected: ev.connected, deviceName: ev.deviceName })
      })
      const errH = await DroggerLocation.addListener('error', (ev) => {
        set({ lastErrorCode: ev.code, connected: false })
      })
      const ntH = await DroggerLocation.addListener('ntripStatusChange', (ev) => {
        set({ ntrip: ev })
      })
      _handles = [locH, stH, errH, ntH]
      // 2. 初期状態を pull
      try {
        const cur = await DroggerLocation.getStatus()
        set({ connected: cur.connected, deviceName: cur.deviceName })
      } catch { /* ignore */ }
      try {
        const ns = await DroggerLocation.getNtripStatus()
        set({ ntrip: ns })
      } catch { /* ignore */ }
      // 3. BT 自動接続 (前セッション残留があれば stop してから start)
      try {
        await DroggerLocation.stop().catch(() => undefined)
        await startWithAutoDetect()
      } catch (e) {
        console.warn('Drogger BT auto-start failed:', e)
      }
    })()
    return _startPromise
  },

  reconnect: async () => {
    try {
      await DroggerLocation.stop().catch(() => undefined)
      await startWithAutoDetect()
      set({ lastUpdateAt: Date.now(), lastErrorCode: null })
    } catch (e) {
      console.warn('Drogger reconnect failed:', e)
      throw e
    }
  },

  disconnect: async () => {
    try {
      await DroggerLocation.stop()
      set({ connected: false, deviceName: null })
    } catch (e) {
      console.warn('Drogger disconnect failed:', e)
      throw e
    }
  },
}))

/** テスト用: listener を 一度剥がして 初期化フラグを リセット */
export async function _resetDroggerConnectionForTests(): Promise<void> {
  for (const h of _handles) await h.remove().catch(() => undefined)
  _handles = []
  _initialized = false
  _startPromise = null
}
