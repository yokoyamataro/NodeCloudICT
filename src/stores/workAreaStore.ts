import { create } from 'zustand'
import { errorMessage } from '@/lib/errorMessage'
import { withRetry } from '@/lib/retry'
import type { BoundaryKind } from '@/lib/boundaryKind'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from './farmStore'
import { useProjectListStore } from './projectListStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { generateAreaCalculationSheet } from '@/lib/area-calculation'
import type { WorkType, AreaCalculationSheet, DesignWorkArea, DesignCoordinate } from '@/types/database'

// 工事区域の座標点（design_coordinatesから取得したデータ）
export interface WorkAreaPoint {
  id: string // design_coordinatesのID
  pointNumber: string
  x: number
  y: number
  z: number | null
  lat: number | null
  lng: number | null
  sortOrder: number
}

// 工事区域
export interface WorkAreaRow {
  id: string
  workType: WorkType
  zoneNumber: string
  name: string
  pointIds: string[] // design_coordinatesのID配列（順序付き）
  points: WorkAreaPoint[] // 展開した座標データ
  areaSqm: number | null
  areaHa: number | null
  perimeterM: number | null
  notes: string | null
  /** 地番のみ: 確定境界 の 構成点 (立会の 成果)。 仮 とは 別の 形。
   *  point_ids / points は 従来どおり 仮境界 (当初) の 分。 */
  confirmedPointIds: string[]
  confirmedPoints: WorkAreaPoint[]
  confirmedAreaSqm: number | null
  confirmedAreaHa: number | null
  confirmedPerimeterM: number | null
}

// 工種別の工事区域データ
type WorkAreasRecord = Partial<Record<WorkType, WorkAreaRow[]>>

/**
 * 仮 / 確定 で 触る フィールド を 差し替える ため の 小道具。
 * 地番 は 1 行 の まま 構成点 だけ 2 本 持つ (point_ids / confirmed_point_ids)。
 */
function pointsOfKind(a: WorkAreaRow, kind: BoundaryKind): WorkAreaPoint[] {
  return kind === 'confirmed' ? a.confirmedPoints : a.points
}
function idsOfKind(a: WorkAreaRow, kind: BoundaryKind): string[] {
  return kind === 'confirmed' ? a.confirmedPointIds : a.pointIds
}
/** kind 側 の 構成点 / 面積 を 差し替えた 新しい 行 を 返す */
function withKind(
  a: WorkAreaRow,
  kind: BoundaryKind,
  patch: {
    ids?: string[]
    points?: WorkAreaPoint[]
    areaSqm?: number | null
    areaHa?: number | null
    perimeterM?: number | null
  },
): WorkAreaRow {
  if (kind === 'confirmed') {
    return {
      ...a,
      ...(patch.ids !== undefined ? { confirmedPointIds: patch.ids } : {}),
      ...(patch.points !== undefined ? { confirmedPoints: patch.points } : {}),
      ...(patch.areaSqm !== undefined ? { confirmedAreaSqm: patch.areaSqm } : {}),
      ...(patch.areaHa !== undefined ? { confirmedAreaHa: patch.areaHa } : {}),
      ...(patch.perimeterM !== undefined ? { confirmedPerimeterM: patch.perimeterM } : {}),
    }
  }
  return {
    ...a,
    ...(patch.ids !== undefined ? { pointIds: patch.ids } : {}),
    ...(patch.points !== undefined ? { points: patch.points } : {}),
    ...(patch.areaSqm !== undefined ? { areaSqm: patch.areaSqm } : {}),
    ...(patch.areaHa !== undefined ? { areaHa: patch.areaHa } : {}),
    ...(patch.perimeterM !== undefined ? { perimeterM: patch.perimeterM } : {}),
  }
}
/** 対象 の 行 だけ 差し替える (workAreas は 工種 → 配列 の 入れ子) */
function mapArea(
  workAreas: WorkAreasRecord,
  workAreaId: string,
  fn: (a: WorkAreaRow) => WorkAreaRow,
): WorkAreasRecord {
  const next = { ...workAreas }
  for (const wt of Object.keys(next) as WorkType[]) {
    const areas = next[wt]
    if (!areas) continue
    const i = areas.findIndex((a) => a.id === workAreaId)
    if (i !== -1) {
      const u = [...areas]
      u[i] = fn(u[i])
      next[wt] = u
      break
    }
  }
  return next
}

interface WorkAreaState {
  // 工事区域データ（工種別）
  workAreas: WorkAreasRecord
  loading: boolean
  error: string | null

  // 変更追跡
  hasChanges: boolean
  pendingWorkAreaIds: string[]

  /**
   * 直近で fetchWorkAreas を完了させた farm の id。
   * 同じ farm で再度 fetchWorkAreas が呼ばれたらキャッシュを使う。
   * 編集系アクションはローカル state を更新するので整合性は保てる。
   * 明示的に再取得したいときは invalidateCache() を使う。
   */
  loadedFarmId: string | null
  invalidateCache: () => void

  // データ取得
  fetchWorkAreas: (farmId: string) => Promise<void>
  /** オフライン スナップショットから 復元する */
  hydrateWorkAreas: (
    areaRows: unknown[],
    coordRows: unknown[],
    zone: number,
    farmId: string,
  ) => void

  // 工事区域操作
  addWorkArea: (workType: WorkType) => Promise<WorkAreaRow | null>
  updateWorkArea: (id: string, updates: Partial<Pick<WorkAreaRow, 'zoneNumber' | 'notes'>>) => void
  deleteWorkArea: (id: string) => Promise<void>

  // 座標点操作（座標管理の座標を追加）
  /** kind を 省くと 仮境界 (従来 の 構成点) を 触る */
  addPoint: (workAreaId: string, coordinate: { id: string; pointNumber: string; x: number; y: number; z: number | null }, kind?: BoundaryKind) => void
  removePoint: (workAreaId: string, coordinateId: string, kind?: BoundaryKind) => void
  reorderPoints: (workAreaId: string, coordinateIds: string[], kind?: BoundaryKind) => void

  // 面積計算
  calculateArea: (workAreaId: string, kind?: BoundaryKind) => AreaCalculationSheet | null

  // 保存
  saveWorkArea: (id: string) => Promise<void>
  saveAllWorkAreas: () => Promise<void>
  resetWorkAreaChanges: () => void

  // 工種別の工事区域を取得
  getWorkAreasByType: (workType: WorkType) => WorkAreaRow[]
  getWorkAreaById: (id: string) => WorkAreaRow | undefined
}

// 工区IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
}

// 座標系を取得するヘルパー（現在の工区が属するプロジェクトの座標系を使う）
const getCurrentZone = (): number => {
  const currentFarm = useFarmStore.getState().currentFarm
  if (!currentFarm) return 13
  const project = useProjectListStore.getState().projects.find(
    (p) => p.id === currentFarm.project_id
  )
  return project?.coordinate_zone ?? 13
}

/**
 * design_work_areas + design_coordinates → WorkAreasRecord。
 * オンライン取得 (fetchWorkAreas) と オフライン復元 (hydrateWorkAreas) で 共用する。
 */
export function buildWorkAreasRecord(
  areas: DesignWorkArea[],
  coordinatesMap: Record<string, DesignCoordinate>,
  zone: number,
): WorkAreasRecord {
  const converter = new CoordinateConverter(zone)
  const workAreasRecord: WorkAreasRecord = {}
  /** point_ids → 展開済み の 構成点。 仮 / 確定 で 同じ 処理 を 使う */
  const expand = (ids: string[]): WorkAreaPoint[] =>
    ids
      .map((id, index) => {
        const coord = coordinatesMap[id]
        if (!coord) return null
        let lat: number | null = null
        let lng: number | null = null
        if (coord.x !== null && coord.y !== null) {
          const result = converter.toLatLng(coord.x, coord.y)
          lat = result.lat
          lng = result.lng
        }
        return {
          id: coord.id,
          pointNumber: coord.point_number,
          x: coord.x,
          y: coord.y,
          z: coord.z,
          lat,
          lng,
          sortOrder: index,
        }
      })
      .filter((p): p is WorkAreaPoint => p !== null)

  for (const area of areas) {
    const pointIds = area.point_ids || []
    const confirmedPointIds = area.confirmed_point_ids || []
    const areaPoints = expand(pointIds)

    const workAreaRow: WorkAreaRow = {
      id: area.id,
      workType: area.work_type,
      zoneNumber: area.zone_number,
      name: area.name,
      pointIds,
      points: areaPoints,
      areaSqm: area.area_sqm,
      areaHa: area.area_ha,
      perimeterM: area.perimeter_m,
      notes: area.notes,
      confirmedPointIds,
      confirmedPoints: expand(confirmedPointIds),
      confirmedAreaSqm: area.confirmed_area_sqm ?? null,
      confirmedAreaHa: area.confirmed_area_ha ?? null,
      confirmedPerimeterM: area.confirmed_perimeter_m ?? null,
    }
    if (!workAreasRecord[area.work_type]) workAreasRecord[area.work_type] = []
    workAreasRecord[area.work_type]!.push(workAreaRow)
  }
  return workAreasRecord
}

export const useWorkAreaStore = create<WorkAreaState>()((set, get) => ({
  workAreas: {},
  loading: false,
  error: null,
  hasChanges: false,
  pendingWorkAreaIds: [],
  loadedFarmId: null,
  invalidateCache: () => set({ loadedFarmId: null }),

  hydrateWorkAreas: (areaRows, coordRows, zone, farmId) => {
    const coordinatesMap: Record<string, DesignCoordinate> = {}
    for (const c of coordRows as DesignCoordinate[]) coordinatesMap[c.id] = c
    set({
      workAreas: buildWorkAreasRecord(areaRows as DesignWorkArea[], coordinatesMap, zone),
      loading: false,
      hasChanges: false,
      pendingWorkAreaIds: [],
      loadedFarmId: farmId,
      error: null,
    })
  },

  fetchWorkAreas: async (farmId: string) => {
    // 同じ farm でロード済みならキャッシュを使う
    if (get().loadedFarmId === farmId) return
    set({ loading: true, error: null, loadedFarmId: null })
    try {
      // 工事区域を取得（既定 1000 行/req の壁に当たるのでページング）
      const typedAreas: DesignWorkArea[] = []
      {
        const PAGE = 1000
        let from = 0
        while (from < 1_000_000) {
          const { data: areas, error: areaError } = await withRetry(() =>
            supabase
              .from('design_work_areas')
              .select('*')
              .eq('farm_id', farmId)
              .order('work_type')
              .order('zone_number')
              .range(from, from + PAGE - 1),
          )
          if (areaError) throw areaError
          const rows = (areas || []) as DesignWorkArea[]
          typedAreas.push(...rows)
          if (rows.length < PAGE) break
          from += PAGE
        }
      }

      if (typedAreas.length === 0) {
        set({ workAreas: {}, loading: false, hasChanges: false, pendingWorkAreaIds: [], loadedFarmId: farmId })
        return
      }

      // design_coordinates は farm_id でページング取得（既定 1000 行/req のため）
      // 安定ページングのため id 昇順で取得する。
      // （ORDER BY なしだとページ境界で行が抜け、地番ポリゴンの構成点
      //   不足で polygon が捨てられて画面に地番が出なくなる）
      //
      // 列は ポリゴン 組み立てに 使う 5 つ だけ。 select('*') だと 備考 や
      // 杭種 まで 全部 運ぶ ことに なり、地番 2000 筆 規模 では 転送量 が
      // 効いて 取得が 落ちる (statement timeout) こと が ある。
      const coordinatesMap: Record<string, DesignCoordinate> = {}
      {
        const PAGE = 1000
        let from = 0
        while (from < 1_000_000) {
          const { data: coords, error: coordError } = await withRetry(() =>
            supabase
              .from('design_coordinates')
              .select('id, point_number, x, y, z')
              .eq('farm_id', farmId)
              .order('id')
              .range(from, from + PAGE - 1),
          )
          if (coordError) throw coordError
          // buildWorkAreasRecord が 読む のは この 5 列 だけ
          const rows = (coords || []) as unknown as DesignCoordinate[]
          for (const c of rows) coordinatesMap[c.id] = c
          if (rows.length < PAGE) break
          from += PAGE
        }
      }

      const workAreasRecord = buildWorkAreasRecord(typedAreas, coordinatesMap, getCurrentZone())

      set({ workAreas: workAreasRecord, loading: false, hasChanges: false, pendingWorkAreaIds: [], loadedFarmId: farmId })
    } catch (err) {
      // Supabase の エラー は Error では なく ただの オブジェクト
      // ({ message, details, hint, code })。 instanceof Error で 弾くと
      // 「工事区域の取得に失敗しました」 しか 出ず、原因 (RLS / timeout /
      // 列違い) が 全く 分からない。 中身を 出す。
      console.error('[workAreaStore] fetchWorkAreas failed', err)
      set({
        error: `工事区域の取得に失敗しました: ${errorMessage(err)}`,
        loading: false,
      })
    }
  },

  addWorkArea: async (workType: WorkType) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return null
    }

    const state = get()
    const existingAreas = state.workAreas[workType] || []
    const zoneNumber = `${workType.charAt(0).toUpperCase()}${existingAreas.length + 1}`
    // name は zoneNumber と同じ値にする。以前は "区域N" を別途持っていたが、
    // 表示・出力共に zoneNumber 一本で足りるため、DB スキーマは維持しつつ
    // 新規作成分は 番号 と 名前 を同一値にして 重複表示を撤去する。
    const name = zoneNumber

    try {
      const { data, error } = await supabase
        .from('design_work_areas')
        .insert({
          farm_id: farmId,
          work_type: workType,
          zone_number: zoneNumber,
          name,
          point_ids: [],
          area_sqm: null,
          area_ha: null,
          perimeter_m: null,
          notes: null,
        } as never)
        .select()
        .single()

      if (error) throw error

      const typedData = data as DesignWorkArea
      const newArea: WorkAreaRow = {
        id: typedData.id,
        workType,
        zoneNumber: typedData.zone_number,
        name: typedData.name,
        pointIds: [],
        points: [],
        areaSqm: null,
        areaHa: null,
        perimeterM: null,
        notes: null,
        confirmedPointIds: [],
        confirmedPoints: [],
        confirmedAreaSqm: null,
        confirmedAreaHa: null,
        confirmedPerimeterM: null,
      }

      set((state) => {
        const newWorkAreas = { ...state.workAreas }
        const existing = newWorkAreas[workType] || []
        newWorkAreas[workType] = [...existing, newArea]
        return { workAreas: newWorkAreas }
      })

      return newArea
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工事区域の作成に失敗しました' })
      return null
    }
  },

  updateWorkArea: (id, updates) => {
    set((state) => {
      const newWorkAreas = { ...state.workAreas }
      for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
        const areas = newWorkAreas[workType]
        if (!areas) continue
        const index = areas.findIndex(a => a.id === id)
        if (index !== -1) {
          const updatedAreas = [...areas]
          updatedAreas[index] = { ...updatedAreas[index], ...updates }
          newWorkAreas[workType] = updatedAreas
          break
        }
      }
      const newPending = state.pendingWorkAreaIds.includes(id)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, id]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
  },

  deleteWorkArea: async (id) => {
    try {
      // 工事区域を削除（point_ids配列なのでwork_area_coordinatesの削除は不要）
      const { error } = await supabase
        .from('design_work_areas')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => {
        const newWorkAreas = { ...state.workAreas }
        for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
          const areas = newWorkAreas[workType]
          if (!areas) continue
          const filtered = areas.filter(a => a.id !== id)
          if (filtered.length !== areas.length) {
            newWorkAreas[workType] = filtered
            break
          }
        }
        return { workAreas: newWorkAreas }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工事区域の削除に失敗しました' })
    }
  },

  addPoint: (workAreaId, coordinate, kind = 'provisional') => {
    const area = get().getWorkAreaById(workAreaId)
    if (!area) return

    // 既に追加されている場合はスキップ
    if (idsOfKind(area, kind).includes(coordinate.id)) return

    const zone = getCurrentZone()
    const converter = new CoordinateConverter(zone)
    let lat: number | null = null
    let lng: number | null = null
    if (coordinate.x !== null && coordinate.y !== null) {
      const result = converter.toLatLng(coordinate.x, coordinate.y)
      lat = result.lat
      lng = result.lng
    }

    const newPoint: WorkAreaPoint = {
      id: coordinate.id,
      pointNumber: coordinate.pointNumber,
      x: coordinate.x,
      y: coordinate.y,
      z: coordinate.z,
      lat,
      lng,
      sortOrder: pointsOfKind(area, kind).length,
    }

    set((state) => {
      const newWorkAreas = mapArea(state.workAreas, workAreaId, (a) =>
        withKind(a, kind, {
          ids: [...idsOfKind(a, kind), coordinate.id],
          points: [...pointsOfKind(a, kind), newPoint],
        }),
      )
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 点が 3 本以上あれば 面積を即時に再計算 (一覧に m² / ha が自動反映される)
    const after = get().getWorkAreaById(workAreaId)
    if (after && pointsOfKind(after, kind).length >= 3) {
      get().calculateArea(workAreaId, kind)
    }
  },

  removePoint: (workAreaId, coordinateId, kind = 'provisional') => {
    set((state) => {
      const newWorkAreas = mapArea(state.workAreas, workAreaId, (a) =>
        withKind(a, kind, {
          ids: idsOfKind(a, kind).filter((id) => id !== coordinateId),
          // sortOrder を 詰め直す
          points: pointsOfKind(a, kind)
            .filter((p) => p.id !== coordinateId)
            .map((p, i) => ({ ...p, sortOrder: i })),
        }),
      )
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 点数変化に追従して 面積を即時に再計算 (3 点未満なら null に戻す)
    const after = get().getWorkAreaById(workAreaId)
    const remaining = after ? pointsOfKind(after, kind).length : 0
    if (remaining >= 3) {
      get().calculateArea(workAreaId, kind)
    } else {
      set((state) => ({
        workAreas: mapArea(state.workAreas, workAreaId, (a) =>
          withKind(a, kind, { areaSqm: null, areaHa: null, perimeterM: null }),
        ),
      }))
    }
  },

  reorderPoints: (workAreaId, coordinateIds, kind = 'provisional') => {
    set((state) => {
      const newWorkAreas = mapArea(state.workAreas, workAreaId, (a) =>
        withKind(a, kind, {
          ids: coordinateIds,
          points: coordinateIds
            .map((id, index) => {
              const point = pointsOfKind(a, kind).find((p) => p.id === id)
              return point ? { ...point, sortOrder: index } : null
            })
            .filter((p): p is WorkAreaPoint => p !== null),
        }),
      )
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 並べ替え直後も 面積を再計算 (向きが変わって面積の符号だけ変わるので値は同じだが 一貫性のため)
    const after = get().getWorkAreaById(workAreaId)
    if (after && pointsOfKind(after, kind).length >= 3) {
      get().calculateArea(workAreaId, kind)
    }
  },

  calculateArea: (workAreaId, kind = 'provisional') => {
    const area = get().getWorkAreaById(workAreaId)
    if (!area || pointsOfKind(area, kind).length < 3) return null

    const points = pointsOfKind(area, kind).map(p => ({
      id: p.id,
      pointNumber: p.pointNumber,
      x: p.x,
      y: p.y,
    }))

    const sheet = generateAreaCalculationSheet(
      workAreaId,
      area.zoneNumber,
      area.name,
      points
    )

    // ローカル状態を更新
    set((state) => {
      const newWorkAreas = mapArea(state.workAreas, workAreaId, (a) =>
        withKind(a, kind, {
          areaSqm: sheet.area_sqm,
          areaHa: sheet.area_ha,
          perimeterM: sheet.perimeter_m,
        }),
      )
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })

    return sheet
  },

  saveWorkArea: async (id) => {
    const area = get().getWorkAreaById(id)
    if (!area) return

    try {
      // 工事区域を更新（point_ids配列を保存）
      await supabase
        .from('design_work_areas')
        .update({
          zone_number: area.zoneNumber,
          name: area.name,
          point_ids: area.pointIds,
          area_sqm: area.areaSqm,
          area_ha: area.areaHa,
          perimeter_m: area.perimeterM,
          // 確定境界 の 構成点 / 面積 (地番のみ。 他の 工種 は 常に 空)
          confirmed_point_ids: area.confirmedPointIds,
          confirmed_area_sqm: area.confirmedAreaSqm,
          confirmed_area_ha: area.confirmedAreaHa,
          confirmed_perimeter_m: area.confirmedPerimeterM,
          notes: area.notes,
        } as never)
        .eq('id', id)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存に失敗しました' })
    }
  },

  saveAllWorkAreas: async () => {
    const state = get()
    const pendingIds = [...state.pendingWorkAreaIds]
    for (const id of pendingIds) {
      await get().saveWorkArea(id)
    }
    set({ hasChanges: false, pendingWorkAreaIds: [] })
  },

  resetWorkAreaChanges: () => {
    // 変更フラグをリセット（データは再フェッチで復元）
    const farmId = getCurrentFarmId()
    set({ hasChanges: false, pendingWorkAreaIds: [] })
    if (farmId) {
      get().fetchWorkAreas(farmId)
    }
  },

  getWorkAreasByType: (workType) => {
    return get().workAreas[workType] || []
  },

  getWorkAreaById: (id) => {
    const workAreas = get().workAreas
    for (const workType of Object.keys(workAreas) as WorkType[]) {
      const areas = workAreas[workType]
      if (!areas) continue
      const found = areas.find(a => a.id === id)
      if (found) return found
    }
    return undefined
  },
}))
