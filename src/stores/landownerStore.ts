// 地権者 (landowners) ストア。
// 工区単位で地権者を CRUD し、地番 (parcels) との M:N 関連
// (parcel_landowners) も合わせて操作する。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { Landowner } from '@/types/database'

export type LandownerEditableFields = Pick<
  Landowner,
  | 'full_name'
  | 'postal_code'
  | 'address'
  | 'phone'
  | 'agent_name'
  | 'agent_address'
  | 'agent_phone'
  | 'agent_relation'
  | 'primary_attendance_at'
  | 'secondary_attendance_at'
  | 'notification_method'
  | 'attendance_status'
  | 'notes'
  | 'attribute'
  | 'id_method'
  | 'id_method_other'
  | 'agent_id_method'
  | 'agent_id_method_other'
>

interface State {
  /** ロード済みの farm_id（キャッシュ判定用） */
  loadedFarmId: string | null
  landowners: Landowner[]
  loading: boolean
  error: string | null

  /** parcel_id -> [landowner_id, ...] */
  landownersByParcelId: Map<string, string[]>

  fetchByFarm: (farmId: string) => Promise<void>
  /** 工区配下の全 parcel について parcel_landowners を取り直す */
  fetchAssignmentsByFarm: (farmId: string) => Promise<void>

  createLandowner: (
    farmId: string,
    fields: Partial<LandownerEditableFields> & Pick<LandownerEditableFields, 'full_name'>,
  ) => Promise<Landowner | null>
  updateLandowner: (id: string, patch: Partial<LandownerEditableFields>) => Promise<void>
  deleteLandowner: (id: string) => Promise<void>

  /** parcel に対する地権者割り当てを保存（既存の差分を計算して INSERT/DELETE） */
  setParcelAssignment: (parcelId: string, landownerIds: string[]) => Promise<void>

  invalidateCache: () => void
}

const isoOrNull = (v: string | null | undefined) => (v && v !== '' ? v : null)

export const useLandownerStore = create<State>((set, get) => ({
  loadedFarmId: null,
  landowners: [],
  loading: false,
  error: null,
  landownersByParcelId: new Map(),

  invalidateCache: () => set({ loadedFarmId: null }),

  fetchByFarm: async (farmId) => {
    if (get().loadedFarmId === farmId) return
    set({ loading: true, error: null, landowners: [], landownersByParcelId: new Map() })
    try {
      const { data, error } = await supabase
        .from('landowners')
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at')
      if (error) throw error
      set({ landowners: (data ?? []) as Landowner[], loading: false, loadedFarmId: farmId })
      // 同時に parcel_landowners も取り直す
      await get().fetchAssignmentsByFarm(farmId)
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '地権者の取得に失敗しました',
        loading: false,
        loadedFarmId: null,
      })
    }
  },

  fetchAssignmentsByFarm: async (farmId) => {
    try {
      // farm 配下の parcels の id を引いてから parcel_landowners を引く
      const { data: parcelRows, error: pErr } = await supabase
        .from('parcels')
        .select('id, work_area:design_work_areas!inner(farm_id)')
        .eq('work_area.farm_id', farmId)
      if (pErr) throw pErr
      const parcelIds = ((parcelRows ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (parcelIds.length === 0) {
        set({ landownersByParcelId: new Map() })
        return
      }
      const map = new Map<string, string[]>()
      const CHUNK = 500
      for (let i = 0; i < parcelIds.length; i += CHUNK) {
        const slice = parcelIds.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from('parcel_landowners')
          .select('parcel_id, landowner_id')
          .in('parcel_id', slice)
        if (error) throw error
        for (const row of (data ?? []) as Array<{
          parcel_id: string
          landowner_id: string
        }>) {
          const prev = map.get(row.parcel_id) ?? []
          prev.push(row.landowner_id)
          map.set(row.parcel_id, prev)
        }
      }
      set({ landownersByParcelId: map })
    } catch (err) {
      console.error('parcel_landowners 取得失敗:', err)
    }
  },

  createLandowner: async (farmId, fields) => {
    try {
      const insertBody = {
        farm_id: farmId,
        full_name: fields.full_name,
        postal_code: isoOrNull(fields.postal_code ?? null),
        address: isoOrNull(fields.address ?? null),
        phone: isoOrNull(fields.phone ?? null),
        agent_name: isoOrNull(fields.agent_name ?? null),
        agent_address: isoOrNull(fields.agent_address ?? null),
        agent_phone: isoOrNull(fields.agent_phone ?? null),
        agent_relation: isoOrNull(fields.agent_relation ?? null),
        primary_attendance_at: fields.primary_attendance_at ?? null,
        secondary_attendance_at: fields.secondary_attendance_at ?? null,
        notification_method: fields.notification_method ?? null,
        attendance_status: fields.attendance_status ?? 'not_attended',
        notes: isoOrNull(fields.notes ?? null),
      }
      const { data, error } = await supabase
        .from('landowners')
        .insert(insertBody as never)
        .select()
        .single()
      if (error) throw error
      const created = data as Landowner
      set((state) => ({ landowners: [...state.landowners, created] }))
      return created
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '地権者の作成に失敗しました' })
      return null
    }
  },

  updateLandowner: async (id, patch) => {
    const prev = get().landowners
    // 楽観更新
    set({
      landowners: prev.map((l) => (l.id === id ? ({ ...l, ...patch } as Landowner) : l)),
    })
    try {
      const { error } = await supabase
        .from('landowners')
        .update(patch as never)
        .eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        landowners: prev,
        error: err instanceof Error ? err.message : '地権者の更新に失敗しました',
      })
    }
  },

  deleteLandowner: async (id) => {
    const prev = get().landowners
    set({ landowners: prev.filter((l) => l.id !== id) })
    try {
      const { error } = await supabase.from('landowners').delete().eq('id', id)
      if (error) throw error
      // parcel_landowners は CASCADE で消える。ローカル map からも除去
      set((state) => {
        const next = new Map<string, string[]>()
        for (const [k, v] of state.landownersByParcelId) {
          next.set(
            k,
            v.filter((lid) => lid !== id),
          )
        }
        return { landownersByParcelId: next }
      })
    } catch (err) {
      set({
        landowners: prev,
        error: err instanceof Error ? err.message : '地権者の削除に失敗しました',
      })
    }
  },

  setParcelAssignment: async (parcelId, landownerIds) => {
    const current = get().landownersByParcelId.get(parcelId) ?? []
    const currentSet = new Set(current)
    const targetSet = new Set(landownerIds)
    const toAdd = landownerIds.filter((lid) => !currentSet.has(lid))
    const toRemove = current.filter((lid) => !targetSet.has(lid))

    try {
      if (toAdd.length > 0) {
        const rows = toAdd.map((lid) => ({ parcel_id: parcelId, landowner_id: lid }))
        const { error } = await supabase.from('parcel_landowners').insert(rows as never)
        if (error) throw error
      }
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from('parcel_landowners')
          .delete()
          .eq('parcel_id', parcelId)
          .in('landowner_id', toRemove)
        if (error) throw error
      }
      set((state) => {
        const next = new Map(state.landownersByParcelId)
        next.set(parcelId, [...landownerIds])
        return { landownersByParcelId: next }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '地権者割り当ての保存に失敗しました' })
    }
  },
}))
