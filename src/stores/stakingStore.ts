import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type StakingTargetType = 'coordinate' | 'pipe_vertex' | 'free'

export interface StakingRecord {
  id: string
  farmId: string
  targetType: StakingTargetType
  targetRefId: string | null
  targetVertexIndex: number | null
  targetName: string | null
  targetX: number | null
  targetY: number | null
  targetZ: number | null
  measuredX: number
  measuredY: number
  measuredZ: number | null
  accuracy: number | null
  sampleCount: number | null
  durationSeconds: number | null
  recordedAt: string
  notes: string | null
}

interface StakingRecordRow {
  id: string
  farm_id: string
  target_type: StakingTargetType
  target_ref_id: string | null
  target_vertex_index: number | null
  target_name: string | null
  target_x: number | null
  target_y: number | null
  target_z: number | null
  measured_x: number
  measured_y: number
  measured_z: number | null
  accuracy: number | null
  sample_count: number | null
  duration_seconds: number | null
  recorded_at: string
  notes: string | null
}

function rowToRecord(r: StakingRecordRow): StakingRecord {
  return {
    id: r.id,
    farmId: r.farm_id,
    targetType: r.target_type,
    targetRefId: r.target_ref_id,
    targetVertexIndex: r.target_vertex_index,
    targetName: r.target_name,
    targetX: r.target_x != null ? Number(r.target_x) : null,
    targetY: r.target_y != null ? Number(r.target_y) : null,
    targetZ: r.target_z != null ? Number(r.target_z) : null,
    measuredX: Number(r.measured_x),
    measuredY: Number(r.measured_y),
    measuredZ: r.measured_z != null ? Number(r.measured_z) : null,
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    sampleCount: r.sample_count,
    durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
    recordedAt: r.recorded_at,
    notes: r.notes,
  }
}

interface StakingState {
  records: StakingRecord[]
  loading: boolean
  saving: boolean
  error: string | null

  fetchRecords: (farmId: string) => Promise<void>
  addRecord: (record: Omit<StakingRecord, 'id' | 'recordedAt'>) => Promise<StakingRecord | null>
  deleteRecord: (id: string) => Promise<void>
}

export const useStakingStore = create<StakingState>()((set) => ({
  records: [],
  loading: false,
  saving: false,
  error: null,

  fetchRecords: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('staking_records')
        .select('*')
        .eq('farm_id', farmId)
        .order('recorded_at', { ascending: false })
      if (error) throw error
      set({ records: (data as StakingRecordRow[]).map(rowToRecord), loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '実測記録の取得に失敗しました',
      })
    }
  },

  addRecord: async (rec) => {
    set({ saving: true, error: null })
    try {
      const row = {
        farm_id: rec.farmId,
        target_type: rec.targetType,
        target_ref_id: rec.targetRefId,
        target_vertex_index: rec.targetVertexIndex,
        target_name: rec.targetName,
        target_x: rec.targetX,
        target_y: rec.targetY,
        target_z: rec.targetZ,
        measured_x: rec.measuredX,
        measured_y: rec.measuredY,
        measured_z: rec.measuredZ,
        accuracy: rec.accuracy,
        sample_count: rec.sampleCount,
        duration_seconds: rec.durationSeconds,
        notes: rec.notes,
      }
      const { data, error } = await supabase
        .from('staking_records')
        .insert(row as never)
        .select()
        .single()
      if (error) throw error
      const saved = rowToRecord(data as StakingRecordRow)
      set((s) => ({ records: [saved, ...s.records], saving: false }))
      return saved
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測記録の保存に失敗しました',
      })
      return null
    }
  },

  deleteRecord: async (id) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('staking_records').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ records: s.records.filter((r) => r.id !== id), saving: false }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測記録の削除に失敗しました',
      })
    }
  },
}))
