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
  /** その セット で 測り 始めた 時刻 (スマホ で セット を 選んだ / 作った とき) */
  startedAt: string | null
  /** その セット に 最後 に 記録 が 入った 時刻 */
  endedAt: string | null
}

export type SurveySetPatch = Partial<
  Pick<
    SurveyRecordSet,
    | 'name'
    | 'measuredOn'
    | 'operator'
    | 'baseStation'
    | 'settingsNote'
    | 'slide'
    | 'sortOrder'
    | 'startedAt'
    | 'endedAt'
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
    startedAt: (r.started_at as string) ?? null,
    endedAt: (r.ended_at as string) ?? null,
  }
}

/** 表示名。 未入力 なら 測量日 と 担当者 から 組み立てる */
export function setLabel(s: SurveyRecordSet): string {
  if (s.name && s.name.trim() !== '') return s.name
  const parts = [s.measuredOn ?? '', s.operator ?? ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '(無題のセッション)'
}

/**
 * JST の 「年通算日 (1月1日=001)」 3 桁 を 返す。 例: 1月30日 → '030'
 */
export function jstDayOfYear(now: Date = new Date()): string {
  // JST = UTC + 9h
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000
  const jst = new Date(jstMs)
  // Date は UTC 前提 で 加算 済み な ので 各 get は UTC 系 で 呼ぶ
  const year = jst.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const day = Math.floor((jstMs - jan1) / (24 * 60 * 60 * 1000)) + 1
  return String(day).padStart(3, '0')
}

/** JST 基準 の 「今日 (YYYY-MM-DD)」 */
export function jstTodayIso(now: Date = new Date()): string {
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000
  const jst = new Date(jstMs)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 既存 の セッション 群 から 「今日 (JST)」の 次 の セッション 名 を 生成 する。
 *   NNN{A,B,C,...}   例: 030A / 030B / 030C
 * 既存 の 同日 セッション 数 に 応じて A → Z → AA → AB ... と 続く。
 * 26 を 超え たら 2 文字 表記 に 拡張 (ほぼ 発生 し ない が 一応)。
 */
export function generateDefaultSessionName(
  existingSets: SurveyRecordSet[],
  now: Date = new Date(),
): string {
  const today = jstTodayIso(now)
  const day = jstDayOfYear(now)
  const sameDay = existingSets.filter((s) => s.measuredOn === today)
  const suffix = alphaSuffix(sameDay.length) // 既存 N 個 → 次 は N+1 番目
  return `${day}${suffix}`
}

/** 0-indexed 番号 → A/B/.../Z/AA/AB/... */
function alphaSuffix(index: number): string {
  const A = 'A'.charCodeAt(0)
  if (index < 26) return String.fromCharCode(A + index)
  // 27 番目 以降 は 2 文字。 index=26 → AA、27 → AB, ...
  const first = Math.floor(index / 26) - 1
  const second = index % 26
  return String.fromCharCode(A + first) + String.fromCharCode(A + second)
}

interface State {
  loadedFarmId: string | null
  sets: SurveyRecordSet[]
  /**
   * この 起動 で 測って いる セット。 スマホ の 最初 の 「測定」 で 決める。
   * 端末 に は 残さ ない (別 の 日 / 別 の 作業 で 引きずら ない ため)。
   * 実測 の 保存先 と、誘導 に 使う 補正値 (スライド量) の 出どころ。
   */
  activeSetId: string | null
  setActiveSetId: (id: string | null) => void
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string, force?: boolean) => Promise<void>
  /** セット を 1 つ 作る。 最初 の 1 つ は 既定 に する */
  createSet: (farmId: string, init?: SurveySetPatch) => Promise<SurveyRecordSet | null>
  updateSet: (id: string, patch: SurveySetPatch) => Promise<void>
  /**
   * 作業 の 時刻 を 打つ。
   *   start … まだ 入って いなけれ ば 開始日時 を 今 に する
   *   常に 終了日時 を 今 に する (その セット に 最後 に 触れた 時刻)
   * 失敗 して も 実測 の 邪魔 は しない ので 黙って 流す。
   */
  touchSet: (id: string, opt?: { start?: boolean }) => Promise<void>
  /** 既定 を 移す (工区 に 1 つ) */
  setDefault: (farmId: string, id: string) => Promise<void>
  deleteSet: (id: string) => Promise<void>
  invalidateCache: () => void
}

export const useSurveySetStore = create<State>((set, get) => ({
  loadedFarmId: null,
  sets: [],
  activeSetId: null,
  setActiveSetId: (id) => set({ activeSetId: id }),
  loading: false,
  error: null,

  invalidateCache: () => set({ loadedFarmId: null }),

  fetchByFarm: async (farmId, force = false) => {
    if (get().loadedFarmId !== farmId) set({ activeSetId: null })
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
        started_at: init?.startedAt ?? null,
        ended_at: init?.endedAt ?? null,
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
    if (patch.startedAt !== undefined) body.started_at = patch.startedAt
    if (patch.endedAt !== undefined) body.ended_at = patch.endedAt
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

  touchSet: async (id, opt) => {
    const now = new Date().toISOString()
    const cur = get().sets.find((x) => x.id === id)
    const body: Record<string, unknown> = { ended_at: now }
    const withStart = opt?.start === true && !cur?.startedAt
    if (withStart) body.started_at = now
    set((s) => ({
      sets: s.sets.map((x) =>
        x.id === id ? { ...x, endedAt: now, startedAt: withStart ? now : x.startedAt } : x,
      ),
    }))
    try {
      await supabase.from('survey_record_sets').update(body as never).eq('id', id)
    } catch (e) {
      console.warn('[surveySet] 作業時刻 の 記録 に 失敗', e)
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
