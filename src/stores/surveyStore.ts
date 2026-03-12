import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { SurveyCategory, DesignSurveyData, DesignSurveyCalibration } from '@/types/database'
import { useProjectStore } from './projectStore'

// ローカル状態用の測量データ型
export interface SurveyDataRow {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
  matchedPointId: string | null
  matchedPointType: 'pipe' | 'coordinate' | null
  matchDistance: number | null
  category: SurveyCategory
  dzRaw: number | null
  dzCalibrated: number | null
  notes: string | null
}

// 補正設定
export interface CalibrationSettings {
  isEnabled: boolean
  dzOffset: number
  matchingThreshold: number
}

interface SurveyState {
  // 測量データ
  surveyData: SurveyDataRow[]
  loading: boolean
  error: string | null

  // 補正設定
  calibration: CalibrationSettings

  // データ取得
  fetchSurveyData: (projectId: string) => Promise<void>
  fetchCalibration: (projectId: string) => Promise<void>

  // 測量データ操作
  importSurveyData: (data: Omit<SurveyDataRow, 'id'>[]) => Promise<void>
  updateSurveyData: (id: string, updates: Partial<SurveyDataRow>) => Promise<void>
  deleteSurveyData: (id: string) => Promise<void>
  clearSurveyData: () => Promise<void>

  // マッチング操作
  setMatch: (surveyId: string, matchedPointId: string, matchedPointType: 'pipe' | 'coordinate', distance: number) => Promise<void>
  clearMatch: (surveyId: string) => Promise<void>
  setCategory: (surveyId: string, category: SurveyCategory) => Promise<void>

  // 補正設定操作
  updateCalibration: (settings: Partial<CalibrationSettings>) => Promise<void>
  recalculateDzCalibrated: () => void

  // 一括更新（マッチング結果をまとめて保存）
  saveAllMatches: (matches: Array<{
    surveyId: string
    matchedPointId: string | null
    matchedPointType: 'pipe' | 'coordinate' | null
    matchDistance: number | null
    category: SurveyCategory
    dzRaw: number | null
    dzCalibrated: number | null
  }>) => Promise<void>
}

// プロジェクトIDを取得するヘルパー
const getCurrentProjectId = (): string | null => {
  return useProjectStore.getState().currentProject?.id ?? null
}

export const useSurveyStore = create<SurveyState>()((set, get) => ({
  // 初期状態
  surveyData: [],
  loading: false,
  error: null,
  calibration: {
    isEnabled: false,
    dzOffset: 0,
    matchingThreshold: 0.2,
  },

  // 測量データ取得
  fetchSurveyData: async (projectId: string) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('design_survey_data')
        .select('*')
        .eq('project_id', projectId)
        .order('point_number')

      if (error) throw error

      const surveyData: SurveyDataRow[] = ((data || []) as DesignSurveyData[]).map((row) => ({
        id: row.id,
        pointNumber: row.point_number,
        x: row.x,
        y: row.y,
        z: row.z,
        matchedPointId: row.matched_point_id,
        matchedPointType: row.matched_point_type,
        matchDistance: row.match_distance,
        category: row.category,
        dzRaw: row.dz_raw,
        dzCalibrated: row.dz_calibrated,
        notes: row.notes,
      }))

      set({ surveyData, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '測量データの取得に失敗しました', loading: false })
    }
  },

  // 補正設定取得
  fetchCalibration: async (projectId: string) => {
    try {
      const { data, error } = await supabase
        .from('design_survey_calibration')
        .select('*')
        .eq('project_id', projectId)
        .single()

      if (error && error.code !== 'PGRST116') throw error // PGRST116 = no rows

      if (data) {
        const row = data as DesignSurveyCalibration
        set({
          calibration: {
            isEnabled: row.is_enabled,
            dzOffset: row.dz_offset,
            matchingThreshold: row.matching_threshold,
          },
        })
      }
    } catch (err) {
      console.error('補正設定の取得に失敗:', err)
    }
  },

  // 測量データインポート
  importSurveyData: async (data) => {
    const projectId = getCurrentProjectId()
    if (!projectId) {
      set({ error: 'プロジェクトが選択されていません' })
      return
    }

    set({ loading: true, error: null })
    try {
      // 既存データを削除
      const { error: deleteError } = await supabase
        .from('design_survey_data')
        .delete()
        .eq('project_id', projectId)

      if (deleteError) throw deleteError

      // 新しいデータを挿入
      const insertData = data.map((d) => ({
        project_id: projectId,
        point_number: d.pointNumber,
        x: d.x,
        y: d.y,
        z: d.z,
        matched_point_id: d.matchedPointId,
        matched_point_type: d.matchedPointType,
        match_distance: d.matchDistance,
        category: d.category,
        dz_raw: d.dzRaw,
        dz_calibrated: d.dzCalibrated,
        notes: d.notes,
      }))

      const { data: inserted, error: insertError } = await supabase
        .from('design_survey_data')
        .insert(insertData as never)
        .select()

      if (insertError) throw insertError

      const surveyData: SurveyDataRow[] = ((inserted || []) as DesignSurveyData[]).map((row) => ({
        id: row.id,
        pointNumber: row.point_number,
        x: row.x,
        y: row.y,
        z: row.z,
        matchedPointId: row.matched_point_id,
        matchedPointType: row.matched_point_type,
        matchDistance: row.match_distance,
        category: row.category,
        dzRaw: row.dz_raw,
        dzCalibrated: row.dz_calibrated,
        notes: row.notes,
      }))

      set({ surveyData, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '測量データのインポートに失敗しました', loading: false })
    }
  },

  // 測量データ更新
  updateSurveyData: async (id, updates) => {
    const state = get()
    const existing = state.surveyData.find((d) => d.id === id)
    if (!existing) return

    const updated = { ...existing, ...updates }

    // ローカル状態を即座に更新
    set({
      surveyData: state.surveyData.map((d) => (d.id === id ? updated : d)),
    })

    // Supabaseに保存
    const dbUpdates: Record<string, unknown> = {}
    if (updates.pointNumber !== undefined) dbUpdates.point_number = updates.pointNumber
    if (updates.x !== undefined) dbUpdates.x = updates.x
    if (updates.y !== undefined) dbUpdates.y = updates.y
    if (updates.z !== undefined) dbUpdates.z = updates.z
    if (updates.matchedPointId !== undefined) dbUpdates.matched_point_id = updates.matchedPointId
    if (updates.matchedPointType !== undefined) dbUpdates.matched_point_type = updates.matchedPointType
    if (updates.matchDistance !== undefined) dbUpdates.match_distance = updates.matchDistance
    if (updates.category !== undefined) dbUpdates.category = updates.category
    if (updates.dzRaw !== undefined) dbUpdates.dz_raw = updates.dzRaw
    if (updates.dzCalibrated !== undefined) dbUpdates.dz_calibrated = updates.dzCalibrated
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes

    const { error } = await supabase
      .from('design_survey_data')
      .update(dbUpdates as never)
      .eq('id', id)

    if (error) {
      set({ error: error.message })
    }
  },

  // 測量データ削除
  deleteSurveyData: async (id) => {
    const { error } = await supabase
      .from('design_survey_data')
      .delete()
      .eq('id', id)

    if (error) {
      set({ error: error.message })
      return
    }

    set((state) => ({
      surveyData: state.surveyData.filter((d) => d.id !== id),
    }))
  },

  // 測量データ全削除
  clearSurveyData: async () => {
    const projectId = getCurrentProjectId()
    if (!projectId) return

    const { error } = await supabase
      .from('design_survey_data')
      .delete()
      .eq('project_id', projectId)

    if (error) {
      set({ error: error.message })
      return
    }

    set({ surveyData: [] })
  },

  // マッチング設定
  setMatch: async (surveyId, matchedPointId, matchedPointType, distance) => {
    await get().updateSurveyData(surveyId, {
      matchedPointId,
      matchedPointType,
      matchDistance: distance,
    })
  },

  // マッチング解除
  clearMatch: async (surveyId) => {
    await get().updateSurveyData(surveyId, {
      matchedPointId: null,
      matchedPointType: null,
      matchDistance: null,
      dzRaw: null,
      dzCalibrated: null,
    })
  },

  // カテゴリ変更
  setCategory: async (surveyId, category) => {
    await get().updateSurveyData(surveyId, { category })
  },

  // 補正設定更新
  updateCalibration: async (settings) => {
    const projectId = getCurrentProjectId()
    if (!projectId) return

    const state = get()
    const newCalibration = { ...state.calibration, ...settings }

    // ローカル状態を更新
    set({ calibration: newCalibration })

    // Supabaseに保存（upsert）
    const { error } = await supabase
      .from('design_survey_calibration')
      .upsert({
        project_id: projectId,
        is_enabled: newCalibration.isEnabled,
        dz_offset: newCalibration.dzOffset,
        matching_threshold: newCalibration.matchingThreshold,
      } as never, {
        onConflict: 'project_id',
      })

    if (error) {
      set({ error: error.message })
    }

    // 補正値が変更された場合、すべてのdzCalibratedを再計算
    if (settings.dzOffset !== undefined || settings.isEnabled !== undefined) {
      get().recalculateDzCalibrated()
    }
  },

  // dz補正値を再計算
  recalculateDzCalibrated: () => {
    const state = get()
    const { isEnabled, dzOffset } = state.calibration

    const updatedData = state.surveyData.map((d) => {
      if (d.dzRaw === null) return d
      const dzCalibrated = isEnabled ? d.dzRaw - dzOffset : d.dzRaw
      return { ...d, dzCalibrated }
    })

    set({ surveyData: updatedData })

    // Supabaseに一括更新（非同期で実行）
    ;(async () => {
      for (const d of updatedData) {
        if (d.dzRaw !== null) {
          await supabase
            .from('design_survey_data')
            .update({ dz_calibrated: d.dzCalibrated } as never)
            .eq('id', d.id)
        }
      }
    })()
  },

  // マッチング結果を一括保存
  saveAllMatches: async (matches) => {
    const state = get()

    // ローカル状態を更新
    const updatedData = state.surveyData.map((d) => {
      const match = matches.find((m) => m.surveyId === d.id)
      if (!match) return d
      return {
        ...d,
        matchedPointId: match.matchedPointId,
        matchedPointType: match.matchedPointType,
        matchDistance: match.matchDistance,
        category: match.category,
        dzRaw: match.dzRaw,
        dzCalibrated: match.dzCalibrated,
      }
    })

    set({ surveyData: updatedData })

    // Supabaseに一括更新
    for (const match of matches) {
      const { error } = await supabase
        .from('design_survey_data')
        .update({
          matched_point_id: match.matchedPointId,
          matched_point_type: match.matchedPointType,
          match_distance: match.matchDistance,
          category: match.category,
          dz_raw: match.dzRaw,
          dz_calibrated: match.dzCalibrated,
        } as never)
        .eq('id', match.surveyId)

      if (error) {
        console.error('マッチング保存エラー:', error)
      }
    }
  },
}))
