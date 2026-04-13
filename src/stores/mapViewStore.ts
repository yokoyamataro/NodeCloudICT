import { create } from 'zustand'

// 地図の表示状態（タブ間で共有）
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
}

export const useMapViewStore = create<MapViewState>()((set) => ({
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
}))
