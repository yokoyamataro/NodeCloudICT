// モビリティ機能のクライアントサイド状態管理。
//
// スコープ (この段階):
//   - vehicles: 車両/重機マスタの CRUD
//   - assignments: 割当 (誰がいつからいつまで乗ったか) の start / end / 一覧
//
// 後段:
//   - positions: GPS ping の送信/購読 (別 store or 同 store に足す)
//   - リアルタイム: Supabase Realtime で active assignments を購読

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { Vehicle, VehicleAssignment, VehicleKind } from '@/types/database'

/** ドロップダウン等で使う割当情報 + 補助フィールド (メンバー名など) */
export interface AssignmentWithNames extends VehicleAssignment {
  driver_name: string | null
  driver_email: string | null
}

interface State {
  vehicles: Vehicle[]
  vehiclesLoading: boolean
  vehiclesError: string | null

  /** vehicle_id → 現在稼働中の assignment (ended_at IS NULL) */
  activeAssignments: Map<string, AssignmentWithNames>

  fetchVehicles: (organizationId: string) => Promise<void>
  createVehicle: (input: {
    organization_id: string
    name: string
    plate_or_serial?: string | null
    kind?: VehicleKind
    memo?: string | null
  }) => Promise<Vehicle | null>
  updateVehicle: (
    id: string,
    patch: Partial<Pick<Vehicle, 'name' | 'plate_or_serial' | 'kind' | 'active' | 'memo'>>,
  ) => Promise<void>
  deleteVehicle: (id: string) => Promise<void>

  fetchActiveAssignments: (organizationId: string) => Promise<void>
  /** 割当を開始。driver 未指定なら auth.uid() (自分) をセット */
  startAssignment: (vehicleId: string, driverUserId?: string) => Promise<AssignmentWithNames | null>
  /** 割当を終了 (ended_at = now) */
  endAssignment: (assignmentId: string) => Promise<void>

  /** 特定車両の割当履歴 (started_at DESC, 最大 100 件) */
  fetchAssignmentHistory: (vehicleId: string) => Promise<AssignmentWithNames[]>
}

// profiles + auth.users から表示名を組み立てるヘルパ (RLS で読める範囲だけ)
async function enrichAssignments(
  rows: VehicleAssignment[],
): Promise<AssignmentWithNames[]> {
  if (rows.length === 0) return []
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)))
  const { data: profs } = await supabase
    .from('profiles')
    .select('user_id, full_name')
    .in('user_id', userIds)
  const profMap = new Map<string, string | null>()
  for (const p of (profs ?? []) as { user_id: string; full_name: string | null }[]) {
    profMap.set(p.user_id, p.full_name)
  }
  // email は auth.users にあるが RLS で通常引けない。当面 null で妥協
  return rows.map((r) => ({
    ...r,
    driver_name: profMap.get(r.user_id) ?? null,
    driver_email: null,
  }))
}

export const useMobilityStore = create<State>((set, get) => ({
  vehicles: [],
  vehiclesLoading: false,
  vehiclesError: null,
  activeAssignments: new Map(),

  fetchVehicles: async (organizationId: string) => {
    set({ vehiclesLoading: true, vehiclesError: null })
    try {
      const { data, error } = await supabase
        .from('vehicles')
        .select('*')
        .eq('organization_id', organizationId)
        .order('active', { ascending: false })
        .order('name')
      if (error) throw error
      set({ vehicles: (data ?? []) as Vehicle[], vehiclesLoading: false })
    } catch (err) {
      set({
        vehiclesError: err instanceof Error ? err.message : String(err),
        vehiclesLoading: false,
      })
    }
  },

  createVehicle: async (input) => {
    try {
      const { data, error } = await supabase
        .from('vehicles')
        .insert({
          organization_id: input.organization_id,
          name: input.name,
          plate_or_serial: input.plate_or_serial ?? null,
          kind: input.kind ?? 'car',
          active: true,
          memo: input.memo ?? null,
        } as never)
        .select()
        .single()
      if (error) throw error
      const v = data as Vehicle
      set((s) => ({ vehicles: [v, ...s.vehicles] }))
      return v
    } catch (err) {
      set({ vehiclesError: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  updateVehicle: async (id, patch) => {
    const prev = get().vehicles
    // 楽観的
    set({ vehicles: prev.map((v) => (v.id === id ? { ...v, ...patch } : v)) })
    try {
      const { error } = await supabase
        .from('vehicles')
        .update(patch as never)
        .eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        vehicles: prev,
        vehiclesError: err instanceof Error ? err.message : String(err),
      })
    }
  },

  deleteVehicle: async (id) => {
    const prev = get().vehicles
    set({ vehicles: prev.filter((v) => v.id !== id) })
    try {
      const { error } = await supabase.from('vehicles').delete().eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        vehicles: prev,
        vehiclesError: err instanceof Error ? err.message : String(err),
      })
    }
  },

  fetchActiveAssignments: async (organizationId: string) => {
    try {
      // vehicles を JOIN しないと organization_id で絞れないので、まず vehicles.id を取る
      const { data: vRows } = await supabase
        .from('vehicles')
        .select('id')
        .eq('organization_id', organizationId)
      const vehicleIds = ((vRows ?? []) as { id: string }[]).map((r) => r.id)
      if (vehicleIds.length === 0) {
        set({ activeAssignments: new Map() })
        return
      }
      const { data, error } = await supabase
        .from('vehicle_assignments')
        .select('*')
        .in('vehicle_id', vehicleIds)
        .is('ended_at', null)
      if (error) throw error
      const enriched = await enrichAssignments((data ?? []) as VehicleAssignment[])
      const map = new Map<string, AssignmentWithNames>()
      for (const a of enriched) map.set(a.vehicle_id, a)
      set({ activeAssignments: map })
    } catch (err) {
      console.warn('[mobilityStore] fetchActiveAssignments failed', err)
    }
  },

  startAssignment: async (vehicleId, driverUserId) => {
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = driverUserId ?? userData.user?.id
      if (!uid) throw new Error('not authenticated')
      const { data, error } = await supabase
        .from('vehicle_assignments')
        .insert({
          vehicle_id: vehicleId,
          user_id: uid,
        } as never)
        .select()
        .single()
      if (error) throw error
      const [enriched] = await enrichAssignments([data as VehicleAssignment])
      set((s) => {
        const map = new Map(s.activeAssignments)
        map.set(vehicleId, enriched)
        return { activeAssignments: map }
      })
      return enriched
    } catch (err) {
      set({ vehiclesError: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  endAssignment: async (assignmentId) => {
    try {
      const { data, error } = await supabase
        .from('vehicle_assignments')
        .update({ ended_at: new Date().toISOString() } as never)
        .eq('id', assignmentId)
        .select()
        .single()
      if (error) throw error
      const ended = data as VehicleAssignment
      set((s) => {
        const map = new Map(s.activeAssignments)
        map.delete(ended.vehicle_id)
        return { activeAssignments: map }
      })
    } catch (err) {
      set({ vehiclesError: err instanceof Error ? err.message : String(err) })
    }
  },

  fetchAssignmentHistory: async (vehicleId) => {
    const { data, error } = await supabase
      .from('vehicle_assignments')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('started_at', { ascending: false })
      .limit(100)
    if (error) {
      console.warn('[mobilityStore] fetchAssignmentHistory failed', error)
      return []
    }
    return enrichAssignments((data ?? []) as VehicleAssignment[])
  },
}))
