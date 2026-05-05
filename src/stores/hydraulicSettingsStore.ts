import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 水理計算（許容勾配 / 水理計算書）に共通で使うパラメータ。圃場ごとに保持する。 */
export interface HydraulicSettings {
  /** 計画流量 (mm/day) */
  plannedFlow: number
  /** 配線間隔 (m) */
  pipeInterval: 10 | 12
  /** 吸水管種 1=素焼土管 / 2=合成樹脂管 */
  absorptionPipeType: 1 | 2
  /** 集水管種 1=素焼土管 / 2=合成樹脂管 */
  collectorPipeType: 1 | 2
  /** 実延長の丸め桁数 */
  lengthDecimals: 0 | 1 | 2
}

export const DEFAULT_HYDRAULIC_SETTINGS: HydraulicSettings = {
  plannedFlow: 30,
  pipeInterval: 10,
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
