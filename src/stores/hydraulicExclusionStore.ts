import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 水理延長計算から除外する PlanPoint (区間) を保持する。
 * ユーザが施工計画表の 区間距離 セルにある「×」を押すと、そのセルの
 * segmentDistance は水理延長の累加から差し引かれない (0 として扱う)。
 *
 * 工区ごとに永続化する。PlanPoint.id は施工計画を再生成すると別 UUID に
 * なるため、その場合の設定はマッチせず自然に無効化される。
 */
interface HydraulicExclusionState {
  /** farmId → 除外対象の PlanPoint id 一覧 */
  byFarm: Record<string, string[]>
  isExcluded: (farmId: string | null | undefined, pointId: string) => boolean
  toggle: (farmId: string, pointId: string) => void
}

export const useHydraulicExclusionStore = create<HydraulicExclusionState>()(
  persist(
    (set, get) => ({
      byFarm: {},
      isExcluded: (farmId, pointId) => {
        if (!farmId) return false
        return (get().byFarm[farmId] ?? []).includes(pointId)
      },
      toggle: (farmId, pointId) =>
        set((state) => {
          const cur = state.byFarm[farmId] ?? []
          const next = cur.includes(pointId)
            ? cur.filter((id) => id !== pointId)
            : [...cur, pointId]
          return { byFarm: { ...state.byFarm, [farmId]: next } }
        }),
    }),
    { name: 'nodecloud:hydraulic-exclusion' },
  ),
)
