// 実測 の 記録セット (survey_record_sets) ストア。
//
// 実測 は 日 や 担当者 が 変われば 使う 基準局 も 設定 も 変わる ので、
// スライド量 は セット ごと に 持つ。 同じ 日 / 同じ 人 でも 分けられる。
//
// 記録 (staking_records.record_set_id) は この セット を 指す。 点 ごと に
// 別 の セット へ 移せる ように、記録 側 の 更新 は stakingStore に 任せる。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errorMessage'
import type { SurveySlide } from '@/lib/surveyCalibration'

export interface SurveyRecordSet {
  id: string
  farmId: string
  name: string | null
  /** 測量日 (YYYY-MM-DD) */
  measuredOn: string | null
  operator: string | null
  /** 使用 した 基準局 */
  baseStation: string | null
  settingsNote: string | null
  /** スライド量 */
  slide: SurveySlide
  /** 新しい 記録 を 入れる 先 */
  isDefault: boolean
  sortOrder: number
  createdAt: string
}

export type SurveySetPatch = Partial<
  Pick<
    SurveyRecordSet,
    'name' | 'measuredOn' | 'operator' | 'baseStation' | 'settingsNote' | 'slide' | 'sortOrder'
  >
>

function toSet(r: Record<string, unknown>): SurveyRecordSet {
  const num = (v: unknown) => {
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  return {
    id: String(r.id),
    farmId: String(r.farm_id),
    name: (r.name as string) ?? null,
    measuredOn: (r.measured_on as string) ?? null,
    operator: (r.operator as string) ?? null,
    baseStation: (r.base_station as string) ?? null,
    settingsNote: (r.settings_note as string) ?? null,
    slide: { dx: num(r.dx_offset), dy: num(r.dy_offset), dz: num(r.dz_offset) },
    isDefault: r.is_default === true,
    sortOrder: num(r.sort_order),
    createdAt: String(r.created_at ?? ''),
  }
}

/** 表示名。 未入力 なら 測量日 と 担当者 から 組み立てる */
export function setLabel(s: SurveyRecordSet): string {
  if (s.name && s.name.trim() !== '') return s.name
  const parts = [s.measuredOn ?? '', s.operator ?? ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '(無題のセット)'
}

interface State {
  loadedFarmId: string | null
  sets: SurveyRecordSet[]
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string, force?: boolean) => Promise<void>
  /** セット を 1 つ 作る。 最初 の 1 つ は 既定 に する */
  createSet: (farmId: string, init?: SurveySetPatch) => Promise<SurveyRecordSet | null>
  updateSet: (id: string, patch: SurveySetPatch) => Promise<void>
  /** 既定 を 移す (工区 に 1 つ) */
  setDefault: (farmId: string, id: string) => Promise<void>
  deleteSet: (id: string) => Promise<void>
  invalidateCache: () => void
}

export const useSurveySetStore = create<State>((set, get) => ({
  loadedFarmId: null,
  sets: [],
  loading: false,
  error: null,

  invalidateCache: () => set({ loadedFarmId: null }),

  fetchByFarm: async (farmId, force = false) => {
    if (!force && get().loadedFarmId === farmId) return
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('survey_record_sets')
        .select('*')
        .eq('farm_id', farmId)
        .order('sort_order')
        .order('created_at')
      if (error) throw error
      set({
        sets: (data ?? []).map((r) => toSet(r as Record<string, unknown>)),
        loading: false,
        loadedFarmId: farmId,
      })
    } catch (e) {
      // 未マイグレーション環境 でも 画面 が 死なない ように 空 で 進む
      set({ sets: [], loading: false, loadedFarmId: farmId, error: errorMessage(e) })
    }
  },

  createSet: async (farmId, init) => {
    set({ error: null })
    try {
      const cur = get().sets
      const next = cur.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1
      const body: Record<string, unknown> = {
        farm_id: farmId,
        name: init?.name ?? null,
        measured_on: init?.measuredOn ?? null,
        operator: init?.operator ?? null,
        base_station: init?.baseStation ?? null,
        settings_note: init?.settingsNote ?? null,
        dx_offset: init?.slide?.dx ?? 0,
        dy_offset: init?.slide?.dy ?? 0,
        dz_offset: init?.slide?.dz ?? 0,
        is_default: cur.length === 0,
        sort_order: next,
      }
      const { data, error } = await supabase
        .from('survey_record_sets')
        .insert(body as never)
        .select('*')
        .single()
      if (error) throw error
      const row = toSet(data as Record<string, unknown>)
      set((s) => ({ sets: [...s.sets, row] }))
      return row
    } catch (e) {
      set({ error: errorMessage(e) })
      return null
    }
  },

  updateSet: async (id, patch) => {
    const body: Record<string, unknown> = {}
    if (patch.name !== undefined) body.name = patch.name
    if (patch.measuredOn !== undefined) body.measured_on = patch.measuredOn
    if (patch.operator !== undefined) body.operator = patch.operator
    if (patch.baseStation !== undefined) body.base_station = patch.baseStation
    if (patch.settingsNote !== undefined) body.settings_note = patch.settingsNote
    if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder
    if (patch.slide) {
      body.dx_offset = patch.slide.dx
      body.dy_offset = patch.slide.dy
      body.dz_offset = patch.slide.dz
    }
    // 画面 の 反応 を 待たせない ため 先 に 反映
    set((s) => ({ sets: s.sets.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
    try {
      const { error } = await supabase
        .from('survey_record_sets')
        .update(body as never)
        .eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },

  setDefault: async (farmId, id) => {
    set((s) => ({ sets: s.sets.map((x) => ({ ...x, isDefault: x.id === id })) }))
    try {
      // 一意制約 が ある ので 先 に 全部 下ろす
      await supabase
        .from('survey_record_sets')
        .update({ is_default: false } as never)
        .eq('farm_id', farmId)
      const { error } = await supabase
        .from('survey_record_sets')
        .update({ is_default: true } as never)
        .eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },

  deleteSet: async (id) => {
    try {
      const { error } = await supabase.from('survey_record_sets').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ sets: s.sets.filter((x) => x.id !== id) }))
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },
}))
