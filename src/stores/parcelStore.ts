// 地籍（境界測量）の地番属性 parcels テーブルを扱うストア。
//
// design_work_areas (work_type='boundary_survey') と 1:1 の関係で、
// work_area_id をキーに upsert する。
//
// 仕様メモ:
//   - fetchByWorkAreaIds: 工区ロード後に workAreaStore から ID 一覧を貰って一括取得
//   - upsertParcel: 行が存在しない work_area_id でも INSERT で作成される
//                   （UNIQUE work_area_id があるので衝突時は UPDATE）
//   - 楽観更新（先にローカル反映 → サーバ）

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { Parcel } from '@/types/database'

interface RawParcel {
  id: string
  work_area_id: string
  location: string | null
  parcel_number: string | null
  notes: string | null
  prefecture: string | null
  municipality: string | null
  registered_land_category: string | null
  registered_area_sqm: number | null
  updated_land_category: string | null
  updated_area_sqm: number | null
  registered_owner_address: string | null
  registered_owner_name: string | null
  attribute_code: string | null
  created_at: string
  updated_at: string
}

const toParcel = (r: RawParcel): Parcel => ({
  id: r.id,
  work_area_id: r.work_area_id,
  location: r.location,
  parcel_number: r.parcel_number,
  notes: r.notes,
  prefecture: r.prefecture,
  municipality: r.municipality,
  registered_land_category: r.registered_land_category,
  registered_area_sqm: r.registered_area_sqm,
  updated_land_category: r.updated_land_category,
  updated_area_sqm: r.updated_area_sqm,
  registered_owner_address: r.registered_owner_address,
  registered_owner_name: r.registered_owner_name,
  attribute_code: r.attribute_code,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

export type ParcelEditableFields = Pick<
  Parcel,
  | 'location'
  | 'parcel_number'
  | 'notes'
  | 'prefecture'
  | 'municipality'
  | 'registered_land_category'
  | 'registered_area_sqm'
  | 'updated_land_category'
  | 'updated_area_sqm'
  | 'registered_owner_address'
  | 'registered_owner_name'
  | 'attribute_code'
>

interface ParcelState {
  byWorkAreaId: Map<string, Parcel>
  loading: boolean
  error: string | null

  fetchByWorkAreaIds: (workAreaIds: string[]) => Promise<void>
  /** オフライン スナップショット (parcels の 生行) から 復元する */
  hydrateParcels: (rows: unknown[]) => void
  /** 1 行 upsert（存在しなければ INSERT、あれば UPDATE） */
  upsertParcel: (workAreaId: string, fields: Partial<ParcelEditableFields>) => Promise<Parcel | null>
  /** ローカルキャッシュをクリア（工区切替時など） */
  clear: () => void
}

export const useParcelStore = create<ParcelState>((set, get) => ({
  byWorkAreaId: new Map(),
  loading: false,
  error: null,

  hydrateParcels: (rows) => {
    const next = new Map<string, Parcel>()
    for (const r of rows as RawParcel[]) next.set(r.work_area_id, toParcel(r))
    set({ byWorkAreaId: next, loading: false, error: null })
  },

  fetchByWorkAreaIds: async (workAreaIds) => {
    if (workAreaIds.length === 0) {
      set({ byWorkAreaId: new Map() })
      return
    }
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('parcels')
        .select('*')
        .in('work_area_id', workAreaIds)
      if (error) throw error
      const rows = (data ?? []) as RawParcel[]
      const next = new Map<string, Parcel>()
      for (const r of rows) next.set(r.work_area_id, toParcel(r))
      set({ byWorkAreaId: next, loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'parcels の取得に失敗しました',
        loading: false,
      })
    }
  },

  upsertParcel: async (workAreaId, fields) => {
    const prev = get().byWorkAreaId.get(workAreaId)
    // 楽観: 先にローカル反映
    const optimistic: Parcel = {
      id: prev?.id ?? 'pending',
      work_area_id: workAreaId,
      location: fields.location ?? prev?.location ?? null,
      parcel_number: fields.parcel_number ?? prev?.parcel_number ?? null,
      notes: fields.notes ?? prev?.notes ?? null,
      prefecture: fields.prefecture ?? prev?.prefecture ?? null,
      municipality: fields.municipality ?? prev?.municipality ?? null,
      registered_land_category:
        fields.registered_land_category ?? prev?.registered_land_category ?? null,
      registered_area_sqm: fields.registered_area_sqm ?? prev?.registered_area_sqm ?? null,
      updated_land_category:
        fields.updated_land_category ?? prev?.updated_land_category ?? null,
      updated_area_sqm: fields.updated_area_sqm ?? prev?.updated_area_sqm ?? null,
      registered_owner_address:
        fields.registered_owner_address ?? prev?.registered_owner_address ?? null,
      registered_owner_name: fields.registered_owner_name ?? prev?.registered_owner_name ?? null,
      attribute_code: fields.attribute_code ?? prev?.attribute_code ?? null,
      created_at: prev?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    set((state) => {
      const next = new Map(state.byWorkAreaId)
      next.set(workAreaId, optimistic)
      return { byWorkAreaId: next }
    })

    try {
      const { data, error } = await supabase
        .from('parcels')
        .upsert(
          { work_area_id: workAreaId, ...fields } as never,
          { onConflict: 'work_area_id' },
        )
        .select()
        .single()
      if (error) throw error
      const saved = toParcel(data as RawParcel)
      set((state) => {
        const next = new Map(state.byWorkAreaId)
        next.set(workAreaId, saved)
        return { byWorkAreaId: next, error: null }
      })
      return saved
    } catch (err) {
      // PostgrestError (RLS / CHECK / 列なし 等) は Error インスタンスでないため
      // err.message に直接アクセスして詳細を拾う。code / details / hint も含めて
      // ユーザに見せる文言を組み立てる。
      const e = err as
        | (Partial<{ message: string; code: string; details: string; hint: string }> &
            Record<string, unknown>)
        | null
      const parts = [e?.message, e?.details, e?.hint, e?.code ? `(code: ${e.code})` : null]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
      const message = parts.length > 0 ? parts.join(' — ') : 'parcels の保存に失敗しました'
      // 開発者向け: 完全なエラーオブジェクトをコンソールに残す
      // eslint-disable-next-line no-console
      console.error('[parcelStore] upsertParcel failed', err, { workAreaId, fields })
      // ロールバック
      set((state) => {
        const next = new Map(state.byWorkAreaId)
        if (prev) next.set(workAreaId, prev)
        else next.delete(workAreaId)
        return { byWorkAreaId: next, error: message }
      })
      return null
    }
  },

  clear: () => set({ byWorkAreaId: new Map(), error: null }),
}))
