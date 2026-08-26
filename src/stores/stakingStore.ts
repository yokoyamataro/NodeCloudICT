import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type StakingTargetType = 'coordinate' | 'pipe_vertex' | 'free'
export type SurveyCategory = 'initial' | 'asbuilt' // 起工 / 出来形

export interface StakingRecord {
  id: string
  farmId: string
  surveyCategory: SurveyCategory
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
  /** 設計座標 に リンク して いない (free) 記録同士 を 束ねる 対称ポインタ。 */
  pairedWithId: string | null
}

interface StakingRecordRow {
  id: string
  farm_id: string
  survey_category: SurveyCategory | null
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
  paired_with_id: string | null
}

function rowToRecord(r: StakingRecordRow): StakingRecord {
  return {
    id: r.id,
    farmId: r.farm_id,
    surveyCategory: r.survey_category ?? 'initial',
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
    pairedWithId: r.paired_with_id,
  }
}

interface StakingState {
  records: StakingRecord[]
  loading: boolean
  saving: boolean
  error: string | null

  fetchRecords: (farmId: string) => Promise<void>
  /** 新規 レコード の 作成。 pairedWithId は 初期 null 固定 の ため 引数外。 */
  addRecord: (
    record: Omit<StakingRecord, 'id' | 'recordedAt' | 'pairedWithId'>,
  ) => Promise<StakingRecord | null>
  deleteRecord: (id: string) => Promise<void>
  /**
   * 実測記録 を 座標管理 の 設計座標 に 事後リンクする。
   * coord=null で リンク 解除 (targetType='free' に 戻す)。
   */
  updateRecordTarget: (
    id: string,
    coord: {
      id: string
      pointNumber: string
      x: number
      y: number
      z: number | null
    } | null,
  ) => Promise<void>
  /** 2 レコード を 対称 に ペアリング (paired_with_id を 相互 に セット)。 */
  pairRecords: (idA: string, idB: string) => Promise<void>
  /** 指定 レコード の ペア を 解除 (自分側 と 相手側 の paired_with_id を NULL に)。 */
  unpairRecord: (id: string) => Promise<void>
  /** 実測点名 (target_name) のみ を 更新。 座標 (measured_*) は 変更 しない。 */
  updateRecordName: (id: string, name: string | null) => Promise<void>
}

export const useStakingStore = create<StakingState>()((set, get) => ({
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
        survey_category: rec.surveyCategory,
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

  pairRecords: async (idA, idB) => {
    if (idA === idB) return
    set({ saving: true, error: null })
    try {
      // 既存 の ペア を 事前 に 解除 する (両側)
      const cur = get().records
      const a = cur.find((r) => r.id === idA)
      const b = cur.find((r) => r.id === idB)
      const preExistingIds = new Set<string>()
      if (a?.pairedWithId && a.pairedWithId !== idB) preExistingIds.add(a.pairedWithId)
      if (b?.pairedWithId && b.pairedWithId !== idA) preExistingIds.add(b.pairedWithId)
      for (const oldId of preExistingIds) {
        const { error: eOld } = await supabase
          .from('staking_records')
          .update({ paired_with_id: null } as never)
          .eq('id', oldId)
        if (eOld) throw eOld
      }
      // 双方向 セット。 update().eq() は 影響行 0 でも エラー に ならない ので、
      // .select() で 実際に 更新された 行 を 明示 取得 して 0 件 なら 例外化する。
      const [ra, rb] = await Promise.all([
        supabase
          .from('staking_records')
          .update({ paired_with_id: idB } as never)
          .eq('id', idA)
          .select(),
        supabase
          .from('staking_records')
          .update({ paired_with_id: idA } as never)
          .eq('id', idB)
          .select(),
      ])
      if (ra.error) throw ra.error
      if (rb.error) throw rb.error
      const rowsA = (ra.data ?? []) as StakingRecordRow[]
      const rowsB = (rb.data ?? []) as StakingRecordRow[]
      if (rowsA.length === 0 || rowsB.length === 0) {
        throw new Error(
          `ペア更新 で 影響 0 件 (A:${rowsA.length} / B:${rowsB.length})。 ` +
            'RLS 権限 or paired_with_id 列 の 存在 を 確認 してください。',
        )
      }
      const savedA = rowToRecord(rowsA[0])
      const savedB = rowToRecord(rowsB[0])
      set((s) => ({
        records: s.records.map((r) => {
          if (r.id === idA) return savedA
          if (r.id === idB) return savedB
          if (preExistingIds.has(r.id)) return { ...r, pairedWithId: null }
          return r
        }),
        saving: false,
      }))
    } catch (err) {
      console.error('[stakingStore] pairRecords failed', err, { idA, idB })
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測記録 の ペアリング に 失敗',
      })
    }
  },

  unpairRecord: async (id) => {
    set({ saving: true, error: null })
    try {
      const cur = get().records
      const target = cur.find((r) => r.id === id)
      const partnerId = target?.pairedWithId ?? null
      const ids = partnerId ? [id, partnerId] : [id]
      const { error } = await supabase
        .from('staking_records')
        .update({ paired_with_id: null } as never)
        .in('id', ids)
      if (error) throw error
      set((s) => ({
        records: s.records.map((r) =>
          ids.includes(r.id) ? { ...r, pairedWithId: null } : r,
        ),
        saving: false,
      }))
    } catch (err) {
      console.error('[stakingStore] unpairRecord failed', err, { id })
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測記録 の ペア 解除 に 失敗',
      })
    }
  },

  updateRecordTarget: async (id, coord) => {
    set({ saving: true, error: null })
    try {
      // target_name は 実測時 に つけた 名前 の 保存が 優先 の ため、リンク
      // 時 に 勝手 に 上書き しない。 座標 (target_x/y/z) は 誤差 算出 用 に
      // 設計値 で 更新。 リンク解除 (coord=null) では target_name は 触らない。
      const patch = coord
        ? {
            target_type: 'coordinate' as StakingTargetType,
            target_ref_id: coord.id,
            target_vertex_index: null,
            target_x: coord.x,
            target_y: coord.y,
            target_z: coord.z,
          }
        : {
            target_type: 'free' as StakingTargetType,
            target_ref_id: null,
            target_vertex_index: null,
            target_x: null,
            target_y: null,
            target_z: null,
          }
      const { data, error } = await supabase
        .from('staking_records')
        .update(patch as never)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      const saved = rowToRecord(data as StakingRecordRow)
      set((s) => ({
        records: s.records.map((r) => (r.id === id ? saved : r)),
        saving: false,
      }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '設計座標 のリンク に 失敗しました',
      })
    }
  },

  updateRecordName: async (id, name) => {
    set({ saving: true, error: null })
    try {
      const normalized = name && name.trim().length > 0 ? name.trim() : null
      const { data, error } = await supabase
        .from('staking_records')
        .update({ target_name: normalized } as never)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      const saved = rowToRecord(data as StakingRecordRow)
      set((s) => ({
        records: s.records.map((r) => (r.id === id ? saved : r)),
        saving: false,
      }))
    } catch (err) {
      console.error('[stakingStore] updateRecordName failed', err, { id, name })
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測点名 の 更新 に 失敗',
      })
    }
  },
}))
