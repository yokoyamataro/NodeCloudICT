import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 管素材の種別 */
export type PipeMaterial = 1 | 2 | 3
export const PIPE_MATERIAL_LABEL: Record<PipeMaterial, string> = {
  1: '素焼土管',
  2: '合成樹脂管',
  3: '無孔管',
}

/**
 * Manning 粗度係数 n（水理計算/限界勾配算定用）。
 * 農水系の標準値を暫定採用。工区ごとに override したい要望があれば
 * 個別 override 手段を追加する。
 */
export const MANNING_ROUGHNESS: Record<PipeMaterial, number> = {
  1: 0.013, // 素焼土管
  2: 0.012, // 合成樹脂管
  3: 0.012, // 無孔管
}

/** 水理計算（許容勾配 / 水理計算書）に共通で使うパラメータ。工区ごとに保持する。 */
export interface HydraulicSettings {
  /** 計画流量 (mm/day) */
  plannedFlow: number
  /** 配線間隔 (m) */
  pipeInterval: 10 | 12
  /** 吸水管素材 1=素焼土管 / 2=合成樹脂管 / 3=無孔管 */
  absorptionPipeType: PipeMaterial
  /** 集水管素材 1=素焼土管 / 2=合成樹脂管 / 3=無孔管 */
  collectorPipeType: PipeMaterial
  /** 実延長の丸め桁数 */
  lengthDecimals: 0 | 1 | 2
}

export const DEFAULT_HYDRAULIC_SETTINGS: HydraulicSettings = {
  plannedFlow: 30,
  pipeInterval: 12,
  absorptionPipeType: 2,
  collectorPipeType: 2,
  lengthDecimals: 1,
}

interface HydraulicSettingsState {
  byFarm: Record<string, HydraulicSettings>
  getSettings: (farmId: string | null | undefined) => HydraulicSettings
  setSettings: (farmId: string, patch: Partial<HydraulicSettings>) => void
}

export const useHydraulicSettingsStore = create<HydraulicSettingsState>()(
  persist(
    (set, get) => ({
      byFarm: {},
      getSettings: (farmId) => {
        if (!farmId) return DEFAULT_HYDRAULIC_SETTINGS
        return get().byFarm[farmId] ?? DEFAULT_HYDRAULIC_SETTINGS
      },
      setSettings: (farmId, patch) =>
        set((state) => ({
          byFarm: {
            ...state.byFarm,
            [farmId]: {
              ...(state.byFarm[farmId] ?? DEFAULT_HYDRAULIC_SETTINGS),
              ...patch,
            },
          },
        })),
    }),
    { name: 'nodecloud:hydraulic-settings' },
  ),
)
