// 工区メモ (farm_memos) ストア。
// 一覧取得 / 新規作成 / 更新 / 削除を扱う。写真は attachments テーブルに
// entity_type='farm_memo' / entity_id=memo.id で別途保存する（座標写真と同じ）。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export interface FarmMemo {
  id: string
  farmId: string
  userId: string | null
  content: string
  lat: number | null
  lng: number | null
  /** 端末方位 0..360 度 (0=北, 90=東) */
  headingDeg: number | null
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  farm_id: string
  user_id: string | null
  content: string
  lat: number | string | null
  lng: number | string | null
  heading_deg: number | string | null
  created_at: string
  updated_at: string
}

const toMemo = (r: RawRow): FarmMemo => ({
  id: r.id,
  farmId: r.farm_id,
  userId: r.user_id,
  content: r.content,
  lat: r.lat == null ? null : Number(r.lat),
  lng: r.lng == null ? null : Number(r.lng),
  headingDeg: r.heading_deg == null ? null : Number(r.heading_deg),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface State {
  /** farm_id ごとに分けて保持。複数工区を行き来する想定 */
  byFarm: Map<string, FarmMemo[]>
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string) => Promise<void>
  createMemo: (
    farmId: string,
    init: {
      content: string
      lat?: number | null
      lng?: number | null
      headingDeg?: number | null
    },
  ) => Promise<FarmMemo | null>
  updateMemo: (
    id: string,
    patch: Partial<{
      content: string
      lat: number | null
      lng: number | null
      headingDeg: number | null
    }>,
  ) => Promise<void>
  deleteMemo: (id: string) => Promise<void>
}

export const useFarmMemoStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loading: false,
  error: null,

  fetchByFarm: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('farm_memos')
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at', { ascending: false })
      if (error) throw error
      const rows = ((data ?? []) as RawRow[]).map(toMemo)
      const next = new Map(get().byFarm)
      next.set(farmId, rows)
      set({ byFarm: next, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'メモの取得に失敗しました',
      })
    }
  },

  createMemo: async (farmId, init) => {
    try {
      const { data: userRes } = await supabase.auth.getUser()
      const insertBody = {
        farm_id: farmId,
        user_id: userRes.user?.id ?? null,
        content: init.content,
        lat: init.lat ?? null,
        lng: init.lng ?? null,
        heading_deg: init.headingDeg ?? null,
      }
      const { data, error } = await supabase
        .from('farm_memos')
        .insert(insertBody as never)
        .select('*')
        .single()
      if (error) throw error
      const created = toMemo(data as RawRow)
      const next = new Map(get().byFarm)
      next.set(farmId, [created, ...(next.get(farmId) ?? [])])
      set({ byFarm: next })
      return created
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'メモの作成に失敗しました' })
      // eslint-disable-next-line no-console
      console.error('[farmMemoStore] createMemo failed', err)
      return null
    }
  },

  updateMemo: async (id, patch) => {
    // 楽観更新
    const prevByFarm = get().byFarm
    set((state) => {
      const next = new Map(state.byFarm)
      for (const [farmId, memos] of next) {
        next.set(
          farmId,
          memos.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: new Date().toISOString() } : m)),
        )
      }
      return { byFarm: next }
    })
    try {
      const dbPatch: Record<string, string | number | null> = {}
      if (patch.content !== undefined) dbPatch.content = patch.content
      if (patch.lat !== undefined) dbPatch.lat = patch.lat
      if (patch.lng !== undefined) dbPatch.lng = patch.lng
      if (patch.headingDeg !== undefined) dbPatch.heading_deg = patch.headingDeg
      if (Object.keys(dbPatch).length === 0) return
      const { error } = await supabase
        .from('farm_memos')
        .update(dbPatch as never)
        .eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        byFarm: prevByFarm,
        error: err instanceof Error ? err.message : 'メモの更新に失敗しました',
      })
      // eslint-disable-next-line no-console
      console.error('[farmMemoStore] updateMemo failed', err)
    }
  },

  deleteMemo: async (id) => {
    const prev = get().byFarm
    set((state) => {
      const next = new Map(state.byFarm)
      for (const [farmId, memos] of next) {
        next.set(farmId, memos.filter((m) => m.id !== id))
      }
      return { byFarm: next }
    })
    try {
      const { error } = await supabase.from('farm_memos').delete().eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        byFarm: prev,
        error: err instanceof Error ? err.message : 'メモの削除に失敗しました',
      })
    }
  },
}))
