// Drogger BLE 接続の 全アプリ横断ライフサイクル管理。
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
  /** GGA field 13: 補正の 経過時間 [s]。補正源の 判定 (CLAS / NTRIP) に 使う */
  diffAge: number | null
  /** GGA field 14: 差分基準局 ID */
  stationId: string | null
  lastUpdateAt: number | null
  ntrip: NtripStatus
  lastErrorCode: string | null

  /** アプリ 起動後 1 回だけ 実行される 初期化 (idempotent)。
   *  source='drogger' の 時のみ listener 登録 + BT 自動接続。 */
  ensureStarted: () => Promise<void>
  /** 手動 stop → start */
  reconnect: () => Promise<void>
  /** BLE 接続を 閉じる (ユーザー操作、NTRIP も 一緒に切れる) */
  disconnect: () => Promise<void>
}

// モジュールレベル: 初期化は 1 回だけ、listener は 常に 生きている
let _initialized = false
let _handles: PluginListenerHandle[] = []
let _startPromise: Promise<void> | null = null

/**
 * lastUpdateAt を 書き戻す 最小間隔 [ms]。
 *
 * 位置イベントは 5 Hz で 来るが、この 1 フィールドを 毎回 更新するだけで
 * ストアの 中身が 必ず 変わり、購読している バッジが その頻度で 再レンダー
 * される。鮮度表示は 秒単位 (5 秒で 「停止」判定) なので、1 秒に 1 回で 足りる。
 */
const LAST_UPDATE_THROTTLE_MS = 1000

export const useDroggerConnection = create<DroggerConnectionState>((set, get) => ({
  connected: false,
  deviceName: null,
  fixQuality: null,
  hdop: null,
  satellites: null,
  diffAge: null,
  stationId: null,
  lastUpdateAt: null,
  ntrip: initialNtrip,
  lastErrorCode: null,

  ensureStarted: async () => {
    if (_initialized) return _startPromise ?? undefined
    if (getActiveSource() !== 'drogger') return
    _initialized = true
    _startPromise = (async () => {
      // 1. Listener 登録 (アプリ寿命の 間 生かす)
      // 位置イベントは 5 Hz。毎回 set() すると 購読側 (バッジ) が その頻度で
      // 再レンダーされて 画面が 重くなるので、実際に 値が 変わったときだけ 書く。
      // hdop / satellites / diffAge は 数秒 単位でしか 動かないので、
      // 定常状態では ほとんど 書き込みが 起きない。
      const locH = await DroggerLocation.addListener('location', (ev: DroggerLocationEvent) => {
        const cur = get()
        const diffAge = ev.diffAge ?? null
        const stationId = ev.stationId ?? null
        const changed =
          cur.fixQuality !== ev.fixQuality ||
          cur.hdop !== ev.hdop ||
          cur.satellites !== ev.satellites ||
          cur.diffAge !== diffAge ||
          cur.stationId !== stationId
        const now = Date.now()
        // 鮮度表示用。値が 変わらなくても 「受信が 続いている」ことは
        // 伝える 必要が あるので、間引いた 上で 更新する
        const bumpTime =
          cur.lastUpdateAt == null || now - cur.lastUpdateAt >= LAST_UPDATE_THROTTLE_MS
        if (!changed && !bumpTime) return
        set({
          ...(changed
            ? {
                fixQuality: ev.fixQuality,
                hdop: ev.hdop,
                satellites: ev.satellites,
                diffAge,
                stationId,
              }
            : {}),
          ...(bumpTime ? { lastUpdateAt: now } : {}),
        })
      })
      const stH = await DroggerLocation.addListener('statusChange', (ev) => {
        // 切れたら 測位まわりは 消す。残したままだと 受信機の 電源を 切っても
        // 直前の Fix (RTK-FIX / RFLOAT) が 出たままに なって 嘘に なる
        set(
          ev.connected
            ? { connected: true, deviceName: ev.deviceName }
            : {
                connected: false,
                deviceName: ev.deviceName,
                fixQuality: null,
                hdop: null,
                satellites: null,
                diffAge: null,
                stationId: null,
              },
        )
      })
      // 受信機と 繋がっているかは statusChange だけが 決める。
      //
      // ここで connected を 倒してはいけない。error は 受信機の BLE だけでなく
      // NTRIP キャスターの エラー (ntrip_io) も 同じ 経路で 流れてくるので、
      // モバイル回線が 切れただけで バッジが 「切断」に なる。しかも BLE は
      // 繋がったままで statusChange(true) が 二度と 来ないため、一度 倒れると
      // 戻らなくなる。
      const errH = await DroggerLocation.addListener('error', (ev) => {
        set({ lastErrorCode: ev.code })
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
