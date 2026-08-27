import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { Alignment, AlignmentSegment } from '@/lib/landxml/types'

interface AlignmentDbRow {
  id: string
  farm_id: string
  name: string
  sta_start: number | null
  total_length: number | null
  source_file: string | null
  segments: AlignmentSegment[] | null
  created_at: string
  updated_at: string
}

interface AlignmentState {
  alignments: Alignment[]
  /** 現在 alignments に 入っている データが 属する farm ID。
   *  farm 切替時に この値が 変わると、fetch 完了前でも 古い alignments を 表示しないよう
   *  UI 側は loadedForFarmId !== currentFarm.id なら 空扱いに する。 */
  loadedForFarmId: string | null
  loading: boolean
  saving: boolean
  error: string | null

  fetchAlignments: (farmId: string) => Promise<void>
  addAlignments: (farmId: string, alignments: Alignment[]) => Promise<void>
  deleteAlignment: (id: string) => Promise<void>
  clearAlignments: (farmId: string) => Promise<void>
  updateAlignmentName: (id: string, name: string) => Promise<void>
}

function rowToAlignment(row: AlignmentDbRow): Alignment {
  return {
    id: row.id,
    name: row.name,
    staStart: Number(row.sta_start ?? 0),
    totalLength: Number(row.total_length ?? 0),
    sourceFile: row.source_file,
    segments: Array.isArray(row.segments) ? row.segments : [],
  }
}

export const useAlignmentStore = create<AlignmentState>()((set, get) => ({
  alignments: [],
  loadedForFarmId: null,
  loading: false,
  saving: false,
  error: null,

  fetchAlignments: async (farmId) => {
    // 圃場が 前回と 違う 場合 は 即 古い データを クリア (前圃場の 中心線形が
    // 一瞬でも 表示される 事故 を 防ぐ)。 同じ farm の 再フェッチ (reload) は
    // クリアせず ちらつきを 抑える。
    const prev = get().loadedForFarmId
    if (prev !== farmId) {
      set({ alignments: [], loadedForFarmId: null, loading: true, error: null })
    } else {
      set({ loading: true, error: null })
    }
    try {
      const { data, error } = await supabase
        .from('design_alignments')
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at')
      if (error) throw error
      const alignments = (data as AlignmentDbRow[]).map(rowToAlignment)
      set({ alignments, loadedForFarmId: farmId, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '中心線形の取得に失敗しました',
      })
    }
  },

  addAlignments: async (farmId, alignments) => {
    set({ saving: true, error: null })
    try {
      const rows = alignments.map((a) => ({
        farm_id: farmId,
        name: a.name,
        sta_start: a.staStart,
        total_length: a.totalLength,
        source_file: a.sourceFile ?? null,
        segments: a.segments,
      }))
      const { data, error } = await supabase
        .from('design_alignments')
        .insert(rows as never)
        .select()
      if (error) throw error
      const newAlignments = (data as AlignmentDbRow[]).map(rowToAlignment)
      set((s) => ({ alignments: [...s.alignments, ...newAlignments], saving: false }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '中心線形の保存に失敗しました',
      })
    }
  },

  deleteAlignment: async (id) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('design_alignments').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ alignments: s.alignments.filter((a) => a.id !== id), saving: false }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '中心線形の削除に失敗しました',
      })
    }
  },

  clearAlignments: async (farmId) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('design_alignments').delete().eq('farm_id', farmId)
      if (error) throw error
      set({ alignments: [], saving: false })
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '中心線形の削除に失敗しました',
      })
    }
  },

  updateAlignmentName: async (id, name) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase
        .from('design_alignments')
        .update({ name } as never)
        .eq('id', id)
      if (error) throw error
      set((s) => ({
        alignments: s.alignments.map((a) => (a.id === id ? { ...a, name } : a)),
        saving: false,
      }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '中心線形の更新に失敗しました',
      })
    }
  },
}))
