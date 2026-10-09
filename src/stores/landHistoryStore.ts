// 土地の沿革 (parcel_display_histories) ストア。
//
// 登記 CSV (法務局 4600) 取込 時 に 書き込まれる 登記 表示事項 の 履歴 を、
// 工区 単位 で まとめて 取得 し parcel_id → 行列 の Map に 入れる。
//
// 各 行 は 「年月日 (cause_date) + 事由 (reason)」 を 中心 と して、
// 当時 の 地番 / 地目 / 地積 の スナップショット を 持つ。 分筆 / 合筆 /
// 地目変更 / 地積更正 などの 履歴 を 時系列 で 出す 用途。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export interface LandHistoryRow {
  id: string
  parcel_id: string
  order_no: number
  /** その 時点 の 地番 (CSV 上 の 表記 の まま) */
  parcel_number: string | null
  /** その 時点 の 地目 */
  land_category: string | null
  /** その 時点 の 地積 (原文: 「２３２・３２」 の まま) */
  area_text: string | null
  /** 事由 (例: 「○番、○番 に 分筆」「地目変更」「地積更正」) */
  reason: string | null
  /** 原因 日付 (例: 「令和3年7月15日」 / 「2021-07-15」 等 の 文字列) */
  cause_date: string | null
}

export interface LandHistoryInput {
  order_no: number
  parcel_number: string | null
  land_category: string | null
  area_text: string | null
  reason: string | null
  cause_date: string | null
}

interface State {
  loadedFarmId: string | null
  /** parcel_id → order_no 昇順 の 履歴 行 */
  byParcelId: Map<string, LandHistoryRow[]>
  loading: boolean
  fetchByParcelIds: (farmId: string, parcelIds: string[]) => Promise<void>
  /** 既存 を 全消去 して 入れ替える (AI 解析 結果 を 反映 する 用途) */
  replaceForParcel: (parcelId: string, rows: LandHistoryInput[]) => Promise<void>
  clear: () => void
}

const CHUNK = 200

export const useLandHistoryStore = create<State>((set, get) => ({
  loadedFarmId: null,
  byParcelId: new Map(),
  loading: false,

  fetchByParcelIds: async (farmId, parcelIds) => {
    if (parcelIds.length === 0) {
      set({ byParcelId: new Map(), loadedFarmId: farmId })
      return
    }
    if (get().loadedFarmId === farmId) return
    set({ loading: true })
    try {
      const rows: LandHistoryRow[] = []
      for (let i = 0; i < parcelIds.length; i += CHUNK) {
        const slice = parcelIds.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from('parcel_display_histories')
          .select('id, parcel_id, order_no, parcel_number, land_category, area_text, reason, cause_date')
          .in('parcel_id', slice)
          .order('parcel_id')
          .order('order_no')
        if (error) throw error
        for (const r of (data ?? []) as LandHistoryRow[]) rows.push(r)
      }
      const m = new Map<string, LandHistoryRow[]>()
      for (const r of rows) {
        const arr = m.get(r.parcel_id)
        if (arr) arr.push(r)
        else m.set(r.parcel_id, [r])
      }
      set({ byParcelId: m, loadedFarmId: farmId, loading: false })
    } catch (err) {
      console.error('[landHistoryStore] fetch failed', err)
      set({ loading: false })
    }
  },

  replaceForParcel: async (parcelId, rows) => {
    // 既存 の 履歴 を 全消去 → 新しい 行 を insert → ローカル state 更新
    try {
      const { error: delErr } = await supabase
        .from('parcel_display_histories')
        .delete()
        .eq('parcel_id', parcelId)
      if (delErr) throw delErr
      let saved: LandHistoryRow[] = []
      if (rows.length > 0) {
        const payload = rows.map((r) => ({
          parcel_id: parcelId,
          order_no: r.order_no,
          parcel_number: r.parcel_number,
          land_category: r.land_category,
          area_text: r.area_text,
          reason: r.reason,
          cause_date: r.cause_date,
        }))
        const { data, error } = await supabase
          .from('parcel_display_histories')
          .insert(payload as never)
          .select('id, parcel_id, order_no, parcel_number, land_category, area_text, reason, cause_date')
          .order('order_no')
        if (error) throw error
        saved = (data ?? []) as LandHistoryRow[]
      }
      set((state) => {
        const next = new Map(state.byParcelId)
        next.set(parcelId, saved)
        return { byParcelId: next }
      })
    } catch (err) {
      console.error('[landHistoryStore] replaceForParcel failed', err)
      throw err
    }
  },

  clear: () => set({ byParcelId: new Map(), loadedFarmId: null }),
}))

// 新しい 空 配列 を 返さ ない よう に 定数 を 用意。 Zustand の selector で
// `?? []` を 使う と 毎回 参照 が 変わり 無限 再レンダ の 原因 に なる。
export const EMPTY_LAND_HISTORY: readonly LandHistoryRow[] = []

/** 1 行 を 画面表示 用 の 1 文 に 整形 (「年月日 事由」)。 cause_date / reason が
 *  片方 だけ の 場合 は あって いる 方 を 出す。 両方 空 の 時 は 空文字 を 返す。 */
export function formatLandHistoryLine(r: LandHistoryRow): string {
  const date = (r.cause_date ?? '').trim()
  const reason = (r.reason ?? '').trim()
  if (date && reason) return `${date} ${reason}`
  return date || reason || ''
}
