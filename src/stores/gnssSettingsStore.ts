// GNSS / RTK 関連の 端末側設定 (音声ガイダンス / 平均秒数 / アンテナ高 /
// ジオイド補正)。
//
// MobileStakingPage と GpsSettingsModal の 両方から読み書きするので Zustand
// で 共有 + localStorage 永続化。以前は MobileStakingPage の 局所 state に
// 散らばっていたが、GPS設定モーダルに集約するために ここへ引き上げた。

import { create } from 'zustand'

const KEY_AVG_SECONDS = 'rtk:avgSeconds'
const KEY_SOUND_ENABLED = 'rtk:soundEnabled'
const KEY_ANTENNA_HEIGHT = 'rtk:antennaHeight'
const KEY_USE_GEOID = 'rtk:useGeoid'
const KEY_HEADING_UP = 'rtk:headingUp'

function loadNumber(key: string, fallback: number, min?: number, max?: number): number {
  if (typeof localStorage === 'undefined') return fallback
  const s = localStorage.getItem(key)
  const n = s ? parseFloat(s) : NaN
  if (!Number.isFinite(n)) return fallback
  if (min != null && n < min) return min
  if (max != null && n > max) return max
  return n
}

function loadBool(key: string, fallback: boolean): boolean {
  if (typeof localStorage === 'undefined') return fallback
  const s = localStorage.getItem(key)
  if (s === '1') return true
  if (s === '0') return false
  return fallback
}

function saveLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

interface GnssSettingsState {
  /** 精密モードの 平均秒数 (1〜10 sec)。測定時に この秒数だけ サンプル取得 */
  avgSeconds: number
  /** 音声ガイダンス ON/OFF。FIX時ピッ、近接ピピ、10cm以内ピピピ、FIX喪失ブーッ */
  soundEnabled: boolean
  /** アンテナ高 (m)。RTK ローバー アンテナ位相中心 〜 地表 (測点) までの高さ */
  antennaHeight: number
  /** ジオイド補正の 有効化 (JPGEO2024)。標高 = 楕円体高 − N − アンテナ高 */
  useGeoidCorrection: boolean
  /**
   * 測設の 方位表示の 基準。
   *   false … 北基準 (ノースアップ)。矢印は 真北からの 方位角
   *   true  … 進行方向基準 (ヘディングアップ)。矢印は 自分の 向きからの 相対角
   */
  headingUp: boolean

  setAvgSeconds: (v: number) => void
  setSoundEnabled: (v: boolean) => void
  setAntennaHeight: (v: number) => void
  setUseGeoidCorrection: (v: boolean) => void
  setHeadingUp: (v: boolean) => void
}

export const useGnssSettingsStore = create<GnssSettingsState>((set) => ({
  avgSeconds: loadNumber(KEY_AVG_SECONDS, 1, 1, 10),
  // 既定 OFF (以前も useState(false) 初期化だったので同じ挙動)
  soundEnabled: loadBool(KEY_SOUND_ENABLED, false),
  antennaHeight: loadNumber(KEY_ANTENNA_HEIGHT, 2.0),
  useGeoidCorrection: loadBool(KEY_USE_GEOID, true),
  // 既定 OFF (従来どおり 北基準)
  headingUp: loadBool(KEY_HEADING_UP, false),

  setAvgSeconds: (v) => {
    const clamped = Math.max(1, Math.min(10, Math.round(v)))
    saveLocalStorage(KEY_AVG_SECONDS, String(clamped))
    set({ avgSeconds: clamped })
  },
  setSoundEnabled: (v) => {
    saveLocalStorage(KEY_SOUND_ENABLED, v ? '1' : '0')
    set({ soundEnabled: v })
  },
  setAntennaHeight: (v) => {
    if (!Number.isFinite(v)) return
    saveLocalStorage(KEY_ANTENNA_HEIGHT, String(v))
    set({ antennaHeight: v })
  },
  setUseGeoidCorrection: (v) => {
    saveLocalStorage(KEY_USE_GEOID, v ? '1' : '0')
    set({ useGeoidCorrection: v })
  },
  setHeadingUp: (v) => {
    saveLocalStorage(KEY_HEADING_UP, v ? '1' : '0')
    set({ headingUp: v })
  },
}))
