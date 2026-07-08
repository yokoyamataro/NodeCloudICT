import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// 工程の進捗状態: 完了 (True) / 未完了 (False) の 2 値
// 旧 'in_progress' は SQL 側で 'not_started' に統合済み。
export type WorkStatus = 'not_started' | 'completed'

export interface FarmWorkStatus {
  farmId: string
  workType: string
  status: WorkStatus
}

export const STATUS_LABEL: Record<WorkStatus, string> = {
  not_started: '未完了',
  completed: '完了',
}

interface WorkStatusState {
  // (farmId + ':' + workType) → status
  statusByKey: Map<string, WorkStatus>
  loading: boolean
  error: string | null
  alertedOnce: boolean

  fetchStatuses: (farmIds: string[]) => Promise<void>
  setStatus: (farmId: string, workType: string, status: WorkStatus) => Promise<void>
  /** 完了 ↔ 未完了 の 2 値をトグル */
  toggleStatus: (farmId: string, workType: string) => Promise<void>
  getStatus: (farmId: string, workType: string) => WorkStatus
  /** その工区に「完了」の行が 1 件以上あるか (工区一覧の完了フィルタ用) */
  isFarmCompleted: (farmId: string) => boolean
}

const keyOf = (farmId: string, workType: string) => `${farmId}:${workType}`

export const useWorkStatusStore = create<WorkStatusState>((set, get) => ({
  statusByKey: new Map(),
  loading: false,
  error: null,
  alertedOnce: false,

  getStatus: (farmId, workType) => {
    return get().statusByKey.get(keyOf(farmId, workType)) ?? 'not_started'
  },

  isFarmCompleted: (farmId) => {
    const prefix = `${farmId}:`
    for (const [k, v] of get().statusByKey) {
      if (k.startsWith(prefix) && v === 'completed') return true
    }
    return false
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
        // DB には旧値 'in_progress' が入っている可能性もあるので unknown 化して narrow
        status: string
      }>
      const map = new Map<string, WorkStatus>()
      for (const r of rows) {
        const s: WorkStatus = r.status === 'completed' ? 'completed' : 'not_started'
        map.set(keyOf(r.farm_id, r.work_type), s)
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
          { farm_id: farmId, work_type: workType, status } as never,
          { onConflict: 'farm_id,work_type' },
        )
      if (error) throw error
    } catch (err) {
      // ロールバック + 詳細をコンソールに出して原因特定を容易にする
      console.error('[workStatusStore] setStatus failed', {
        farmId,
        workType,
        status,
        error: err,
      })
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null
          ? JSON.stringify(err)
          : '工程状態の更新に失敗しました'
      set({ statusByKey: prev, error: message })
      if (typeof window !== 'undefined' && !get().alertedOnce) {
        set({ alertedOnce: true })
        alert(`工程状態を保存できませんでした: ${message}`)
      }
    }
  },

  toggleStatus: async (farmId, workType) => {
    const current = get().getStatus(farmId, workType)
    await get().setStatus(farmId, workType, current === 'completed' ? 'not_started' : 'completed')
  },
}))
