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
import type {
  MobilityPosition,
  MobilityProject,
  MobilityProjectMember,
  MobilityProjectPoint,
  Vehicle,
  VehicleAssignment,
  VehicleKind,
} from '@/types/database'

// Supabase の PostgrestError は Error インスタンスではなくプレーンオブジェクトなので、
// String(err) だと "[object Object]" になる。message + details + hint + code を組み立てる。
function extractErr(err: unknown): string {
  if (!err) return 'unknown error'
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const e = err as {
      message?: string
      details?: string
      hint?: string
      code?: string
    }
    const parts: string[] = []
    if (e.message) parts.push(e.message)
    if (e.details) parts.push(`details=${e.details}`)
    if (e.hint) parts.push(`hint=${e.hint}`)
    if (e.code) parts.push(`code=${e.code}`)
    if (parts.length > 0) return parts.join(' | ')
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** ドロップダウン等で使う割当情報 + 補助フィールド (メンバー名など) */
export interface AssignmentWithNames extends VehicleAssignment {
  driver_name: string | null
  driver_email: string | null
  /** ドライバーが選択中の行き先ポイント (RLS で読める範囲でのみ埋まる) */
  destination_point: MobilityProjectPoint | null
}

interface State {
  vehicles: Vehicle[]
  vehiclesLoading: boolean
  vehiclesError: string | null

  /** vehicle_id → 現在稼働中の assignment (ended_at IS NULL) */
  activeAssignments: Map<string, AssignmentWithNames>

  /**
   * assignment_id → 最新 ping。管理画面で通信断バッジ (最終 ping からの経過時間)
   * 計算に使うため store にも保持する。Realtime INSERT / 定期 refresh で更新される。
   */
  latestPositionsByAssignment: Map<string, MobilityPosition>

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
  /**
   * 稼働中割当に「行き先ポイント」をセット/解除。ドライバー本人 or 組織 admin が呼ぶ。
   * pointId=null で解除。成功すると activeAssignments 内の該当行も更新する。
   */
  setAssignmentDestination: (
    assignmentId: string,
    pointId: string | null,
  ) => Promise<{ ok: true } | { ok: false; error: string }>

  /** 特定車両の割当履歴 (started_at DESC, 最大 100 件) */
  fetchAssignmentHistory: (vehicleId: string) => Promise<AssignmentWithNames[]>
  /** 特定ユーザーの割当履歴 (started_at DESC, 最大 100 件) */
  fetchUserAssignmentHistory: (userId: string) => Promise<AssignmentWithNames[]>

  /** 稼働中割当に位置 ping を 1 件 INSERT。RLS は「本人 + ended_at IS NULL」を強制。 */
  sendPosition: (
    assignmentId: string,
    input: {
      lat: number
      lon: number
      accuracy_m?: number | null
      speed_kmh?: number | null
      heading_deg?: number | null
      altitude_m?: number | null
      recorded_at?: string
    },
  ) => Promise<{ ok: true } | { ok: false; error: string }>

  /** 特定 assignment の最近の位置 (recorded_at DESC, 最大 n 件) */
  fetchRecentPositions: (
    assignmentId: string,
    limit?: number,
  ) => Promise<MobilityPosition[]>

  /** 複数 assignment のそれぞれ最新 1 件を取得 (フリート地図用) */
  fetchLatestPositions: (
    assignmentIds: string[],
  ) => Promise<Map<string, MobilityPosition>>
  /** Realtime で受け取った 1 件を latestPositionsByAssignment にマージする */
  applyLatestPosition: (row: MobilityPosition) => void

  /**
   * 指定 user_id の「since 以降」の位置を全部取得 (走行距離集計用)。
   * 直近 24h 分の 10 秒 ping なら最大 8640 行 → limit 上げてクライアント側で
   * 距離集計する想定。
   */
  fetchPositionsForUserSince: (
    userId: string,
    sinceIso: string,
  ) => Promise<MobilityPosition[]>

  /** 指定 vehicle_id の「since 以降」の位置を全 assignment 横断で取得 */
  fetchPositionsForVehicleSince: (
    vehicleId: string,
    sinceIso: string,
  ) => Promise<MobilityPosition[]>

  /**
   * 複数 assignment の全位置を一括取得 (フリート地図の軌跡描画用)。
   * assignment_id → 位置配列 (recorded_at 昇順) の Map を返す。
   */
  fetchPositionsForAssignments: (
    assignmentIds: string[],
    limitPerAssignment?: number,
  ) => Promise<Map<string, MobilityPosition[]>>

  /**
   * 指定 org の指定期間内に started_at がある assignment を全部取得。
   * 日別運行ログ集計用。ドライバー名も enrich して返す。
   */
  fetchOrgAssignmentsBetween: (
    orgId: string,
    startIso: string,
    endIso: string,
  ) => Promise<AssignmentWithNames[]>

  // ============================================================
  // 運行現場 (mobility_projects)
  // ============================================================
  fetchProjects: (organizationId: string) => Promise<MobilityProject[]>
  /** 指定ユーザーが割当てられている現場の一覧 (ドライバー画面用) */
  fetchMyAssignedProjects: (userId: string) => Promise<MobilityProject[]>
  createProject: (input: {
    organization_id: string
    name: string
    description?: string | null
  }) => Promise<MobilityProject | null>
  updateProject: (
    id: string,
    patch: Partial<Pick<MobilityProject, 'name' | 'description' | 'active'>>,
  ) => Promise<void>
  deleteProject: (id: string) => Promise<void>

  fetchProjectMembers: (projectId: string) => Promise<MobilityProjectMember[]>
  addProjectMember: (projectId: string, userId: string) => Promise<void>
  removeProjectMember: (projectId: string, userId: string) => Promise<void>

  fetchProjectPoints: (projectId: string) => Promise<MobilityProjectPoint[]>
  createPoint: (input: {
    project_id: string
    name: string
    kind?: string | null
    lat: number
    lon: number
    memo?: string | null
    display_order?: number
  }) => Promise<MobilityProjectPoint | null>
  updatePoint: (
    id: string,
    patch: Partial<
      Pick<
        MobilityProjectPoint,
        'name' | 'kind' | 'lat' | 'lon' | 'memo' | 'active' | 'display_order'
      >
    >,
  ) => Promise<void>
  deletePoint: (id: string) => Promise<void>
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

  // 行き先ポイントも一括取得 (RLS: 同組織メンバーは mobility_project_points を読める)
  const destIds = Array.from(
    new Set(
      rows
        .map((r) => r.destination_point_id)
        .filter((v): v is string => v != null),
    ),
  )
  const destMap = new Map<string, MobilityProjectPoint>()
  if (destIds.length > 0) {
    const { data: pts } = await supabase
      .from('mobility_project_points')
      .select('*')
      .in('id', destIds)
    for (const p of (pts ?? []) as MobilityProjectPoint[]) {
      destMap.set(p.id, p)
    }
  }

  // email は auth.users にあるが RLS で通常引けない。当面 null で妥協
  return rows.map((r) => ({
    ...r,
    driver_name: profMap.get(r.user_id) ?? null,
    driver_email: null,
    destination_point: r.destination_point_id
      ? destMap.get(r.destination_point_id) ?? null
      : null,
  }))
}

export const useMobilityStore = create<State>((set, get) => ({
  vehicles: [],
  vehiclesLoading: false,
  vehiclesError: null,
  activeAssignments: new Map(),
  latestPositionsByAssignment: new Map(),

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
        vehiclesError: extractErr(err),
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
      set({ vehiclesError: extractErr(err) })
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
        vehiclesError: extractErr(err),
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
        vehiclesError: extractErr(err),
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
      set({ vehiclesError: extractErr(err) })
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
      set({ vehiclesError: extractErr(err) })
    }
  },

  setAssignmentDestination: async (assignmentId, pointId) => {
    try {
      const patch = pointId
        ? {
            destination_point_id: pointId,
            destination_set_at: new Date().toISOString(),
          }
        : { destination_point_id: null, destination_set_at: null }
      const { data, error } = await supabase
        .from('vehicle_assignments')
        .update(patch as never)
        .eq('id', assignmentId)
        .select()
        .single()
      if (error) throw error
      const updated = data as VehicleAssignment
      // enrich (destination_point を埋め直す) してから activeAssignments を差し替え
      const [enriched] = await enrichAssignments([updated])
      set((s) => {
        const map = new Map(s.activeAssignments)
        // 既存の driver_name などが失われないように必要ならマージ
        const existing = map.get(updated.vehicle_id)
        map.set(updated.vehicle_id, {
          ...(existing ?? enriched),
          ...enriched,
        })
        return { activeAssignments: map }
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
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

  fetchUserAssignmentHistory: async (userId) => {
    const { data, error } = await supabase
      .from('vehicle_assignments')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(100)
    if (error) {
      console.warn('[mobilityStore] fetchUserAssignmentHistory failed', error)
      return []
    }
    return enrichAssignments((data ?? []) as VehicleAssignment[])
  },

  sendPosition: async (assignmentId, input) => {
    try {
      const { error } = await supabase
        .from('mobility_positions')
        .insert({
          assignment_id: assignmentId,
          recorded_at: input.recorded_at ?? new Date().toISOString(),
          lat: input.lat,
          lon: input.lon,
          accuracy_m: input.accuracy_m ?? null,
          speed_kmh: input.speed_kmh ?? null,
          heading_deg: input.heading_deg ?? null,
          altitude_m: input.altitude_m ?? null,
        } as never)
      if (error) throw error
      return { ok: true }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  fetchRecentPositions: async (assignmentId, limit = 20) => {
    const { data, error } = await supabase
      .from('mobility_positions')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('recorded_at', { ascending: false })
      .limit(limit)
    if (error) {
      console.warn('[mobilityStore] fetchRecentPositions failed', error)
      return []
    }
    return (data ?? []) as MobilityPosition[]
  },

  fetchPositionsForUserSince: async (userId, sinceIso) => {
    // 自分の assignment の id を先に引く (positions は assignment 経由なので)
    const { data: aRows, error: aErr } = await supabase
      .from('vehicle_assignments')
      .select('id')
      .eq('user_id', userId)
      .gte('started_at', sinceIso)
    if (aErr) {
      console.warn('[mobilityStore] fetchPositionsForUserSince (assignments) failed', aErr)
      return []
    }
    const ids = ((aRows ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return []
    const { data, error } = await supabase
      .from('mobility_positions')
      .select('*')
      .in('assignment_id', ids)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: true })
      .limit(10000)
    if (error) {
      console.warn('[mobilityStore] fetchPositionsForUserSince failed', error)
      return []
    }
    return (data ?? []) as MobilityPosition[]
  },

  fetchPositionsForVehicleSince: async (vehicleId, sinceIso) => {
    const { data: aRows, error: aErr } = await supabase
      .from('vehicle_assignments')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .gte('started_at', sinceIso)
    if (aErr) {
      console.warn('[mobilityStore] fetchPositionsForVehicleSince (assignments) failed', aErr)
      return []
    }
    const ids = ((aRows ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return []
    const { data, error } = await supabase
      .from('mobility_positions')
      .select('*')
      .in('assignment_id', ids)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: true })
      .limit(20000)
    if (error) {
      console.warn('[mobilityStore] fetchPositionsForVehicleSince failed', error)
      return []
    }
    return (data ?? []) as MobilityPosition[]
  },

  fetchOrgAssignmentsBetween: async (orgId, startIso, endIso) => {
    // まず org 内の車両 id を取る
    const { data: vRows, error: vErr } = await supabase
      .from('vehicles')
      .select('id')
      .eq('organization_id', orgId)
    if (vErr) {
      console.warn('[mobilityStore] fetchOrgAssignmentsBetween (vehicles) failed', vErr)
      return []
    }
    const vehicleIds = ((vRows ?? []) as { id: string }[]).map((r) => r.id)
    if (vehicleIds.length === 0) return []
    // started_at がその日に含まれる assignment を取得
    const { data, error } = await supabase
      .from('vehicle_assignments')
      .select('*')
      .in('vehicle_id', vehicleIds)
      .gte('started_at', startIso)
      .lt('started_at', endIso)
      .order('started_at', { ascending: true })
    if (error) {
      console.warn('[mobilityStore] fetchOrgAssignmentsBetween failed', error)
      return []
    }
    return enrichAssignments((data ?? []) as VehicleAssignment[])
  },

  fetchPositionsForAssignments: async (assignmentIds, limitPerAssignment = 500) => {
    if (assignmentIds.length === 0) return new Map()
    const { data, error } = await supabase
      .from('mobility_positions')
      .select('*')
      .in('assignment_id', assignmentIds)
      .order('recorded_at', { ascending: true })
      .limit(assignmentIds.length * limitPerAssignment)
    if (error) {
      console.warn('[mobilityStore] fetchPositionsForAssignments failed', error)
      return new Map()
    }
    const map = new Map<string, MobilityPosition[]>()
    for (const row of (data ?? []) as MobilityPosition[]) {
      const arr = map.get(row.assignment_id)
      if (arr) arr.push(row)
      else map.set(row.assignment_id, [row])
    }
    return map
  },

  fetchLatestPositions: async (assignmentIds) => {
    if (assignmentIds.length === 0) {
      set({ latestPositionsByAssignment: new Map() })
      return new Map()
    }
    // PostgREST では DISTINCT ON が直接使えないので、単純に IN で取って
    // クライアント側で assignment_id ごとに最新 1 件を選ぶ。
    // 件数が多い場合 (数百以上) はサーバ側 RPC を検討する。
    const { data, error } = await supabase
      .from('mobility_positions')
      .select('*')
      .in('assignment_id', assignmentIds)
      .order('recorded_at', { ascending: false })
      .limit(assignmentIds.length * 50) // 各 assignment につき最大 50 件見れば十分
    if (error) {
      console.warn('[mobilityStore] fetchLatestPositions failed', error)
      return new Map()
    }
    const map = new Map<string, MobilityPosition>()
    for (const row of (data ?? []) as MobilityPosition[]) {
      if (!map.has(row.assignment_id)) map.set(row.assignment_id, row)
    }
    // ストアにも保持 (通信断判定に使う)
    set({ latestPositionsByAssignment: map })
    return map
  },

  applyLatestPosition: (row) => {
    set((s) => {
      const existing = s.latestPositionsByAssignment.get(row.assignment_id)
      if (
        existing &&
        new Date(existing.recorded_at).getTime() >=
          new Date(row.recorded_at).getTime()
      ) {
        return s // 既存の方が新しい → 何もしない
      }
      const next = new Map(s.latestPositionsByAssignment)
      next.set(row.assignment_id, row)
      return { latestPositionsByAssignment: next }
    })
  },

  // ============================================================
  // 運行現場 (mobility_projects)
  // ============================================================
  fetchProjects: async (organizationId) => {
    const { data, error } = await supabase
      .from('mobility_projects')
      .select('*')
      .eq('organization_id', organizationId)
      .order('active', { ascending: false })
      .order('name')
    if (error) {
      console.warn('[mobilityStore] fetchProjects failed', error)
      return []
    }
    return (data ?? []) as MobilityProject[]
  },

  fetchMyAssignedProjects: async (userId) => {
    // まず自分の割当を取得 → project_id を集める
    const { data: mRows, error: mErr } = await supabase
      .from('mobility_project_members')
      .select('project_id')
      .eq('user_id', userId)
    if (mErr) {
      console.warn('[mobilityStore] fetchMyAssignedProjects (members) failed', mErr)
      return []
    }
    const ids = ((mRows ?? []) as { project_id: string }[]).map((r) => r.project_id)
    if (ids.length === 0) return []
    const { data, error } = await supabase
      .from('mobility_projects')
      .select('*')
      .in('id', ids)
      .eq('active', true)
      .order('name')
    if (error) {
      console.warn('[mobilityStore] fetchMyAssignedProjects (projects) failed', error)
      return []
    }
    return (data ?? []) as MobilityProject[]
  },

  createProject: async (input) => {
    const { data: userData } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('mobility_projects')
      .insert({
        organization_id: input.organization_id,
        name: input.name,
        description: input.description ?? null,
        active: true,
        created_by: userData.user?.id ?? null,
      } as never)
      .select()
      .single()
    if (error) {
      console.warn('[mobilityStore] createProject failed', error)
      return null
    }
    return data as MobilityProject
  },

  updateProject: async (id, patch) => {
    const { error } = await supabase
      .from('mobility_projects')
      .update(patch as never)
      .eq('id', id)
    if (error) console.warn('[mobilityStore] updateProject failed', error)
  },

  deleteProject: async (id) => {
    const { error } = await supabase.from('mobility_projects').delete().eq('id', id)
    if (error) console.warn('[mobilityStore] deleteProject failed', error)
  },

  fetchProjectMembers: async (projectId) => {
    const { data, error } = await supabase
      .from('mobility_project_members')
      .select('*')
      .eq('project_id', projectId)
    if (error) {
      console.warn('[mobilityStore] fetchProjectMembers failed', error)
      return []
    }
    return (data ?? []) as MobilityProjectMember[]
  },

  addProjectMember: async (projectId, userId) => {
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase.from('mobility_project_members').insert({
      project_id: projectId,
      user_id: userId,
      role: 'driver',
      added_by: userData.user?.id ?? null,
    } as never)
    if (error) console.warn('[mobilityStore] addProjectMember failed', error)
  },

  removeProjectMember: async (projectId, userId) => {
    const { error } = await supabase
      .from('mobility_project_members')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', userId)
    if (error) console.warn('[mobilityStore] removeProjectMember failed', error)
  },

  fetchProjectPoints: async (projectId) => {
    const { data, error } = await supabase
      .from('mobility_project_points')
      .select('*')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true })
      .order('name')
    if (error) {
      console.warn('[mobilityStore] fetchProjectPoints failed', error)
      return []
    }
    return (data ?? []) as MobilityProjectPoint[]
  },

  createPoint: async (input) => {
    const { data, error } = await supabase
      .from('mobility_project_points')
      .insert({
        project_id: input.project_id,
        name: input.name,
        kind: input.kind ?? null,
        lat: input.lat,
        lon: input.lon,
        memo: input.memo ?? null,
        active: true,
        display_order: input.display_order ?? 0,
      } as never)
      .select()
      .single()
    if (error) {
      console.warn('[mobilityStore] createPoint failed', error)
      return null
    }
    return data as MobilityProjectPoint
  },

  updatePoint: async (id, patch) => {
    const { error } = await supabase
      .from('mobility_project_points')
      .update(patch as never)
      .eq('id', id)
    if (error) console.warn('[mobilityStore] updatePoint failed', error)
  },

  deletePoint: async (id) => {
    const { error } = await supabase.from('mobility_project_points').delete().eq('id', id)
    if (error) console.warn('[mobilityStore] deletePoint failed', error)
  },
}))
