import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// 工程の進捗状態
// 将来細分化が予想されるため、リテラル型で集約しておく
export type WorkStatus = 'not_started' | 'in_progress' | 'completed'

export interface FarmWorkStatus {
  farmId: string
  workType: string
  status: WorkStatus
}

// 状態の循環順序: クリックで未着手 → 進行中 → 完了 → 未着手
export const NEXT_STATUS: Record<WorkStatus, WorkStatus> = {
  not_started: 'in_progress',
  in_progress: 'completed',
  completed: 'not_started',
}

export const STATUS_LABEL: Record<WorkStatus, string> = {
  not_started: '未着手',
  in_progress: '進行中',
  completed: '完了',
}

interface WorkStatusState {
  // (farmId + ':' + workType) → status
  statusByKey: Map<string, WorkStatus>
  loading: boolean
  error: string | null

  fetchStatuses: (farmIds: string[]) => Promise<void>
  setStatus: (farmId: string, workType: string, status: WorkStatus) => Promise<void>
  cycleStatus: (farmId: string, workType: string) => Promise<void>
  getStatus: (farmId: string, workType: string) => WorkStatus
}

const keyOf = (farmId: string, workType: string) => `${farmId}:${workType}`

export const useWorkStatusStore = create<WorkStatusState>((set, get) => ({
  statusByKey: new Map(),
  loading: false,
  error: null,

  getStatus: (farmId, workType) => {
    return get().statusByKey.get(keyOf(farmId, workType)) ?? 'not_started'
  },

  fetchStatuses: async (farmIds) => {
    if (farmIds.length === 0) {
      set({ statusByKey: new Map() })
      return
    }
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('farm_work_status')
        .select('farm_id, work_type, status')
        .in('farm_id', farmIds)
      if (error) throw error
      const rows = (data ?? []) as Array<{
        farm_id: string
        work_type: string
        status: WorkStatus
      }>
      const map = new Map<string, WorkStatus>()
      for (const r of rows) {
        map.set(keyOf(r.farm_id, r.work_type), r.status)
      }
      set({ statusByKey: map, loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '工程状態の取得に失敗しました',
        loading: false,
      })
    }
  },

  setStatus: async (farmId, workType, status) => {
    // 楽観更新
    const prev = get().statusByKey
    const next = new Map(prev)
    next.set(keyOf(farmId, workType), status)
    set({ statusByKey: next })

    try {
      const { error } = await supabase
        .from('farm_work_status')
        .upsert(
          { farm_id: farmId, work_type: workType, status },
          { onConflict: 'farm_id,work_type' },
        )
      if (error) throw error
    } catch (err) {
      // ロールバック
      set({
        statusByKey: prev,
        error: err instanceof Error ? err.message : '工程状態の更新に失敗しました',
      })
    }
  },

  cycleStatus: async (farmId, workType) => {
    const current = get().getStatus(farmId, workType)
    await get().setStatus(farmId, workType, NEXT_STATUS[current])
  },
}))
