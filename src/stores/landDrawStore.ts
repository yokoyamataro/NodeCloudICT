// 地積測量図 (land_survey_drawings) ストア。 工区単位 で 複数枚 を CRUD する。
//
// spec / frame は DB 側 が jsonb な ので、読み込み で 既定値 を 埋めて から
// 画面 に 渡す。 こう して おく と 画面側 で 毎回 ?? を 書かずに 済む。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errorMessage'
import { DEFAULT_FRAME, type FloorPlanFrame } from '@/features/boundary-survey/floorPlanTypes'
import {
  DEFAULT_LAND_SPEC,
  EMPTY_MARKERS,
  type LandDrawSpec,
  type LandSurveyDrawing,
} from '@/features/boundary-survey/landDrawTypes'

export type LandDrawPatch = Partial<
  Pick<
    LandSurveyDrawing,
    'title' | 'location' | 'spec' | 'frame' | 'scale_denominator' | 'sheet_no' | 'sort_order'
  >
>

function normalize(row: Record<string, unknown>): LandSurveyDrawing {
  const raw = (row.spec ?? {}) as Partial<LandDrawSpec>
  const spec: LandDrawSpec = {
    ...DEFAULT_LAND_SPEC,
    ...raw,
    markers: { ...EMPTY_MARKERS, ...(raw.markers ?? {}) },
    paramNote: { ...DEFAULT_LAND_SPEC.paramNote, ...(raw.paramNote ?? {}) },
    parcelIds: Array.isArray(raw.parcelIds) ? raw.parcelIds : [],
    controlPointIds: Array.isArray(raw.controlPointIds) ? raw.controlPointIds : [],
    datums: Array.isArray(raw.datums) ? raw.datums : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  }
  return {
    id: String(row.id),
    farm_id: String(row.farm_id),
    title: (row.title as string) ?? null,
    location: (row.location as string) ?? null,
    spec,
    frame: { ...DEFAULT_FRAME, ...((row.frame ?? {}) as Partial<FloorPlanFrame>) },
    scale_denominator: Number(row.scale_denominator ?? 500),
    sheet_no: Number(row.sheet_no ?? 1),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

interface State {
  loadedFarmId: string | null
  drawings: LandSurveyDrawing[]
  loading: boolean
  saving: boolean
  error: string | null

  fetchByFarm: (farmId: string, force?: boolean) => Promise<void>
  createDrawing: (farmId: string, zone: number) => Promise<LandSurveyDrawing | null>
  duplicateDrawing: (id: string) => Promise<LandSurveyDrawing | null>
  updateDrawing: (id: string, patch: LandDrawPatch) => Promise<void>
  deleteDrawing: (id: string) => Promise<void>
  invalidateCache: () => void
}

export const useLandDrawStore = create<State>((set, get) => ({
  loadedFarmId: null,
  drawings: [],
  loading: false,
  saving: false,
  error: null,

  invalidateCache: () => set({ loadedFarmId: null }),

  fetchByFarm: async (farmId, force = false) => {
    if (!force && get().loadedFarmId === farmId) return
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('land_survey_drawings')
        .select('*')
        .eq('farm_id', farmId)
        .order('sort_order')
        .order('created_at')
      if (error) throw error
      set({
        drawings: (data ?? []).map((r) => normalize(r as Record<string, unknown>)),
        loading: false,
        loadedFarmId: farmId,
      })
    } catch (e) {
      set({ loading: false, error: errorMessage(e) })
    }
  },

  createDrawing: async (farmId, zone) => {
    set({ saving: true, error: null })
    try {
      const next = get().drawings.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1
      const { data, error } = await supabase
        .from('land_survey_drawings')
        .insert({
          farm_id: farmId,
          sort_order: next,
          spec: { ...DEFAULT_LAND_SPEC, zone },
          frame: DEFAULT_FRAME,
        } as never)
        .select('*')
        .single()
      if (error) throw error
      const row = normalize(data as Record<string, unknown>)
      set((s) => ({ drawings: [...s.drawings, row], saving: false }))
      return row
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
      return null
    }
  },

  duplicateDrawing: async (id) => {
    const src = get().drawings.find((p) => p.id === id)
    if (!src) return null
    set({ saving: true, error: null })
    try {
      const next = get().drawings.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1
      const { data, error } = await supabase
        .from('land_survey_drawings')
        .insert({
          farm_id: src.farm_id,
          title: src.title ? `${src.title}（${src.sheet_no + 1}枚目）` : null,
          location: src.location,
          spec: src.spec,
          frame: src.frame,
          scale_denominator: src.scale_denominator,
          sheet_no: src.sheet_no + 1,
          sort_order: next,
        } as never)
        .select('*')
        .single()
      if (error) throw error
      const row = normalize(data as Record<string, unknown>)
      set((s) => ({ drawings: [...s.drawings, row], saving: false }))
      return row
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
      return null
    }
  },

  updateDrawing: async (id, patch) => {
    // 画面 の 反応 を 待たせない ため 先 に 反映 して から 書く
    set((s) => ({
      drawings: s.drawings.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      saving: true,
      error: null,
    }))
    try {
      const { error } = await supabase
        .from('land_survey_drawings')
        .update(patch as never)
        .eq('id', id)
      if (error) throw error
      set({ saving: false })
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
    }
  },

  deleteDrawing: async (id) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('land_survey_drawings').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ drawings: s.drawings.filter((p) => p.id !== id), saving: false }))
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
    }
  },
}))
