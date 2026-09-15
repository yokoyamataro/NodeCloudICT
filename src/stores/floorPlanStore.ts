// 各階平面図 (floor_plans) ストア。 工区単位 で 複数枚 を CRUD する。
//
// floors / placement / frame は DB 側 が jsonb な ので、読み込み で 既定値 を
// 埋めて から 画面 に 渡す。 こう して おく と 画面側 で 毎回 ?? を 書かずに 済む。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errorMessage'
import {
  DEFAULT_FRAME,
  DEFAULT_SITE,
  type FloorFigure,
  type FloorPlan,
  type FloorPlanFrame,
  type SitePlan,
} from '@/features/boundary-survey/floorPlanTypes'

/** 画面 から 更新 できる 列 */
export type FloorPlanPatch = Partial<
  Pick<
    FloorPlan,
    | 'title'
    | 'location'
    | 'parcel_number'
    | 'house_number'
    | 'building_kind'
    | 'building_structure'
    | 'parcel_id'
    | 'figures'
    | 'site'
    | 'frame'
    | 'plan_scale'
    | 'site_scale'
    | 'sheet_no'
    | 'sort_order'
  >
>

function normalize(row: Record<string, unknown>): FloorPlan {
  const figures = Array.isArray(row.figures) ? (row.figures as FloorFigure[]) : []
  const site = { ...DEFAULT_SITE, ...((row.site ?? {}) as Partial<SitePlan>) }
  const frame = { ...DEFAULT_FRAME, ...((row.frame ?? {}) as Partial<FloorPlanFrame>) }
  return {
    id: String(row.id),
    farm_id: String(row.farm_id),
    title: (row.title as string) ?? null,
    location: (row.location as string) ?? null,
    parcel_number: (row.parcel_number as string) ?? null,
    house_number: (row.house_number as string) ?? null,
    building_kind: (row.building_kind as string) ?? null,
    building_structure: (row.building_structure as string) ?? null,
    parcel_id: (row.parcel_id as string) ?? null,
    figures,
    site,
    frame,
    plan_scale: Number(row.plan_scale ?? 250),
    site_scale: Number(row.site_scale ?? 500),
    sheet_no: Number(row.sheet_no ?? 1),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

interface State {
  loadedFarmId: string | null
  plans: FloorPlan[]
  loading: boolean
  saving: boolean
  error: string | null

  fetchByFarm: (farmId: string, force?: boolean) => Promise<void>
  createPlan: (farmId: string) => Promise<FloorPlan | null>
  duplicatePlan: (id: string) => Promise<FloorPlan | null>
  updatePlan: (id: string, patch: FloorPlanPatch) => Promise<void>
  deletePlan: (id: string) => Promise<void>
  invalidateCache: () => void
}

export const useFloorPlanStore = create<State>((set, get) => ({
  loadedFarmId: null,
  plans: [],
  loading: false,
  saving: false,
  error: null,

  invalidateCache: () => set({ loadedFarmId: null }),

  fetchByFarm: async (farmId, force = false) => {
    if (!force && get().loadedFarmId === farmId) return
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('floor_plans')
        .select('*')
        .eq('farm_id', farmId)
        .order('sort_order')
        .order('created_at')
      if (error) throw error
      set({
        plans: (data ?? []).map((r) => normalize(r as Record<string, unknown>)),
        loading: false,
        loadedFarmId: farmId,
      })
    } catch (e) {
      set({ loading: false, error: errorMessage(e) })
    }
  },

  createPlan: async (farmId) => {
    set({ saving: true, error: null })
    try {
      const next = get().plans.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1
      const { data, error } = await supabase
        .from('floor_plans')
        .insert({
          farm_id: farmId,
          sort_order: next,
          site: DEFAULT_SITE,
          frame: DEFAULT_FRAME,
        } as never)
        .select('*')
        .single()
      if (error) throw error
      const row = normalize(data as Record<string, unknown>)
      set((s) => ({ plans: [...s.plans, row], saving: false }))
      return row
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
      return null
    }
  },

  duplicatePlan: async (id) => {
    const src = get().plans.find((p) => p.id === id)
    if (!src) return null
    set({ saving: true, error: null })
    try {
      const next = get().plans.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1
      const { data, error } = await supabase
        .from('floor_plans')
        .insert({
          farm_id: src.farm_id,
          title: src.title ? `${src.title}（${src.sheet_no + 1}枚目）` : null,
          location: src.location,
          parcel_number: src.parcel_number,
          house_number: src.house_number,
          building_kind: src.building_kind,
          building_structure: src.building_structure,
          parcel_id: src.parcel_id,
          figures: src.figures,
          site: src.site,
          frame: src.frame,
          plan_scale: src.plan_scale,
          site_scale: src.site_scale,
          sheet_no: src.sheet_no + 1,
          sort_order: next,
        } as never)
        .select('*')
        .single()
      if (error) throw error
      const row = normalize(data as Record<string, unknown>)
      set((s) => ({ plans: [...s.plans, row], saving: false }))
      return row
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
      return null
    }
  },

  updatePlan: async (id, patch) => {
    // 画面 の 反応 を 待たせない ため 先 に 反映 して から 書く
    set((s) => ({
      plans: s.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      saving: true,
      error: null,
    }))
    try {
      const { error } = await supabase.from('floor_plans').update(patch as never).eq('id', id)
      if (error) throw error
      set({ saving: false })
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
    }
  },

  deletePlan: async (id) => {
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('floor_plans').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ plans: s.plans.filter((p) => p.id !== id), saving: false }))
    } catch (e) {
      set({ saving: false, error: errorMessage(e) })
    }
  },
}))
