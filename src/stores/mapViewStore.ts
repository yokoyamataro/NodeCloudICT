import { create } from 'zustand'
import type { BaseLayerType } from '@/components/map/CoordinateMap'
import { COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { STAKE_STATUS_OPTIONS, type StakeStatus } from '@/types/database'

// 地図の表示状態（タブ間で共有）
// ・center / zoom: 異なる地図コンポーネント間で位置を同期
// ・visibleTypes / showOrtho / baseLayer: 座標管理 ↔ 地番管理 で
//   フィルタや背景レイヤーが巻き戻らないように共有 + localStorage 永続化
interface MapViewState {
  // 地図の中心位置
  center: [number, number] | null
  // ズームレベル
  zoom: number | null
  // 初期化済みかどうか（最初のフィットが完了したか）
  isInitialized: boolean

  // 地図状態を更新
  setView: (center: [number, number], zoom: number) => void
  // 初期化フラグをセット
  setInitialized: (value: boolean) => void
  // リセット（プロジェクト切り替え時）
  resetView: () => void

  // ── 表示設定（座標管理 / 地番管理 で共有） ─────────────────────
  /** 点種フィルタ。空集合は許容しない（最低 1 件残す） */
  visibleTypes: Set<string>
  /** 設置状態フィルタ（地籍測量のワークフロー）。空集合は許容しない */
  visibleStakeStatuses: Set<StakeStatus>
  /** オルソ画像レイヤーの表示 ON/OFF */
  showOrtho: boolean
  /** 背景地図の種類 */
  baseLayer: BaseLayerType
  /** 法務省地図 (地番) を背景レイヤとして表示するか。全ページ共有 */
  showParcelMap: boolean

  setVisibleTypes: (next: Set<string>) => void
  /** 1 件トグル。結果が空集合なら無視 */
  toggleVisibleType: (code: string) => void
  setVisibleStakeStatuses: (next: Set<StakeStatus>) => void
  toggleVisibleStakeStatus: (status: StakeStatus) => void
  setShowOrtho: (v: boolean) => void
  setBaseLayer: (l: BaseLayerType) => void
  setShowParcelMap: (v: boolean) => void
}

const SETTINGS_KEY = 'mapView:settings:v1'
const DEFAULT_VISIBLE = new Set<string>(Object.keys(COORDINATE_TYPE_NAMES))
const DEFAULT_VISIBLE_STATUSES = new Set<StakeStatus>(STAKE_STATUS_OPTIONS)

interface PersistShape {
  visibleTypes?: string[]
  visibleStakeStatuses?: string[]
  showOrtho?: boolean
  baseLayer?: BaseLayerType
  showParcelMap?: boolean
}

function loadSettings(): {
  visibleTypes: Set<string>
  visibleStakeStatuses: Set<StakeStatus>
  showOrtho: boolean
  baseLayer: BaseLayerType
  showParcelMap: boolean
} {
  const fallback = {
    visibleTypes: new Set(DEFAULT_VISIBLE),
    visibleStakeStatuses: new Set(DEFAULT_VISIBLE_STATUSES),
    showOrtho: true,
    baseLayer: 'osm' as BaseLayerType,
    showParcelMap: false,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as PersistShape
    const vt =
      Array.isArray(parsed.visibleTypes) && parsed.visibleTypes.length > 0
        ? new Set(parsed.visibleTypes.filter((s): s is string => typeof s === 'string'))
        : new Set<string>(DEFAULT_VISIBLE)
    // 設置状態は STAKE_STATUS_OPTIONS のいずれかのみ受け付ける。
    // 旧スキーマ（'none' / 'needed' / 'permanent' / 'impossible' 等）が
    // 残っていてフィルタで一部だけ落ちると、ユーザは新コード
    // ('unset' / 'new' / 'replaced' / 'skip') を選んだ覚えがないのに
    // それらの座標が見えなくなる。検知したら全表示に戻す。
    const validStatusSet = new Set<string>(STAKE_STATUS_OPTIONS)
    const savedArr = Array.isArray(parsed.visibleStakeStatuses)
      ? parsed.visibleStakeStatuses
      : []
    const filteredArr = savedArr.filter(
      (s): s is StakeStatus => typeof s === 'string' && validStatusSet.has(s),
    )
    const schemaChanged = savedArr.length > 0 && filteredArr.length !== savedArr.length
    const vss =
      schemaChanged || filteredArr.length === 0
        ? new Set<StakeStatus>(DEFAULT_VISIBLE_STATUSES)
        : new Set<StakeStatus>(filteredArr)
    const baseLayer: BaseLayerType =
      parsed.baseLayer === 'gsi-photo' || parsed.baseLayer === 'gsi-std' ? parsed.baseLayer : 'osm'
    return {
      visibleTypes: vt,
      visibleStakeStatuses: vss,
      showOrtho: typeof parsed.showOrtho === 'boolean' ? parsed.showOrtho : true,
      baseLayer,
      showParcelMap: typeof parsed.showParcelMap === 'boolean' ? parsed.showParcelMap : false,
    }
  } catch {
    return fallback
  }
}

function saveSettings(
  visibleTypes: Set<string>,
  visibleStakeStatuses: Set<StakeStatus>,
  showOrtho: boolean,
  baseLayer: BaseLayerType,
  showParcelMap: boolean,
) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        visibleTypes: Array.from(visibleTypes),
        visibleStakeStatuses: Array.from(visibleStakeStatuses),
        showOrtho,
        baseLayer,
        showParcelMap,
      }),
    )
  } catch {
    /* ignore quota errors */
  }
}

export const useMapViewStore = create<MapViewState>()((set, get) => {
  const initial = loadSettings()
  return {
    center: null,
    zoom: null,
    isInitialized: false,

    setView: (center, zoom) => {
      set({ center, zoom, isInitialized: true })
    },

    setInitialized: (value) => {
      set({ isInitialized: value })
    },

    resetView: () => {
      set({ center: null, zoom: null, isInitialized: false })
    },

    visibleTypes: initial.visibleTypes,
    visibleStakeStatuses: initial.visibleStakeStatuses,
    showOrtho: initial.showOrtho,
    baseLayer: initial.baseLayer,
    showParcelMap: initial.showParcelMap,

    setVisibleTypes: (next) => {
      if (next.size === 0) return
      set({ visibleTypes: next })
      const s = get()
      saveSettings(next, s.visibleStakeStatuses, s.showOrtho, s.baseLayer, s.showParcelMap)
    },
    toggleVisibleType: (code) => {
      const next = new Set(get().visibleTypes)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      if (next.size === 0) return
      set({ visibleTypes: next })
      const s = get()
      saveSettings(next, s.visibleStakeStatuses, s.showOrtho, s.baseLayer, s.showParcelMap)
    },
    setVisibleStakeStatuses: (next) => {
      if (next.size === 0) return
      set({ visibleStakeStatuses: next })
      const s = get()
      saveSettings(s.visibleTypes, next, s.showOrtho, s.baseLayer, s.showParcelMap)
    },
    toggleVisibleStakeStatus: (status) => {
      const next = new Set(get().visibleStakeStatuses)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      if (next.size === 0) return
      set({ visibleStakeStatuses: next })
      const s = get()
      saveSettings(s.visibleTypes, next, s.showOrtho, s.baseLayer, s.showParcelMap)
    },
    setShowOrtho: (v) => {
      set({ showOrtho: v })
      const s = get()
      saveSettings(s.visibleTypes, s.visibleStakeStatuses, v, s.baseLayer, s.showParcelMap)
    },
    setBaseLayer: (l) => {
      set({ baseLayer: l })
      const s = get()
      saveSettings(s.visibleTypes, s.visibleStakeStatuses, s.showOrtho, l, s.showParcelMap)
    },
    setShowParcelMap: (v) => {
      set({ showParcelMap: v })
      const s = get()
      saveSettings(s.visibleTypes, s.visibleStakeStatuses, s.showOrtho, s.baseLayer, v)
    },
  }
})
