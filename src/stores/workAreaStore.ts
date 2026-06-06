import { create } from 'zustand'
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
}

// 工種別の工事区域データ
type WorkAreasRecord = Partial<Record<WorkType, WorkAreaRow[]>>

interface WorkAreaState {
  // 工事区域データ（工種別）
  workAreas: WorkAreasRecord
  loading: boolean
  error: string | null

  // 変更追跡
  hasChanges: boolean
  pendingWorkAreaIds: string[]

  // データ取得
  fetchWorkAreas: (farmId: string) => Promise<void>

  // 工事区域操作
  addWorkArea: (workType: WorkType) => Promise<WorkAreaRow | null>
  updateWorkArea: (id: string, updates: Partial<Pick<WorkAreaRow, 'zoneNumber' | 'notes'>>) => void
  deleteWorkArea: (id: string) => Promise<void>

  // 座標点操作（座標管理の座標を追加）
  addPoint: (workAreaId: string, coordinate: { id: string; pointNumber: string; x: number; y: number; z: number | null }) => void
  removePoint: (workAreaId: string, coordinateId: string) => void
  reorderPoints: (workAreaId: string, coordinateIds: string[]) => void

  // 面積計算
  calculateArea: (workAreaId: string) => AreaCalculationSheet | null

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

export const useWorkAreaStore = create<WorkAreaState>()((set, get) => ({
  workAreas: {},
  loading: false,
  error: null,
  hasChanges: false,
  pendingWorkAreaIds: [],

  fetchWorkAreas: async (farmId: string) => {
    set({ loading: true, error: null })
    try {
      // 工事区域を取得（既定 1000 行/req の壁に当たるのでページング）
      const typedAreas: DesignWorkArea[] = []
      {
        const PAGE = 1000
        let from = 0
        while (from < 1_000_000) {
          const { data: areas, error: areaError } = await supabase
            .from('design_work_areas')
            .select('*')
            .eq('farm_id', farmId)
            .order('work_type')
            .order('zone_number')
            .range(from, from + PAGE - 1)
          if (areaError) throw areaError
          const rows = (areas || []) as DesignWorkArea[]
          typedAreas.push(...rows)
          if (rows.length < PAGE) break
          from += PAGE
        }
      }

      if (typedAreas.length === 0) {
        set({ workAreas: {}, loading: false, hasChanges: false, pendingWorkAreaIds: [] })
        return
      }

      // design_coordinates は farm_id でページング取得（既定 1000 行/req のため）
      const coordinatesMap: Record<string, DesignCoordinate> = {}
      {
        const PAGE = 1000
        let from = 0
        while (from < 1_000_000) {
          const { data: coords, error: coordError } = await supabase
            .from('design_coordinates')
            .select('*')
            .eq('farm_id', farmId)
            .range(from, from + PAGE - 1)
          if (coordError) throw coordError
          const rows = (coords || []) as DesignCoordinate[]
          for (const c of rows) coordinatesMap[c.id] = c
          if (rows.length < PAGE) break
          from += PAGE
        }
      }

      const zone = getCurrentZone()
      const converter = new CoordinateConverter(zone)

      // 工種別にグループ化
      const workAreasRecord: WorkAreasRecord = {}

      for (const area of typedAreas) {
        const pointIds = area.point_ids || []
        const areaPoints: WorkAreaPoint[] = pointIds
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
        }

        if (!workAreasRecord[area.work_type]) {
          workAreasRecord[area.work_type] = []
        }
        workAreasRecord[area.work_type]!.push(workAreaRow)
      }

      set({ workAreas: workAreasRecord, loading: false, hasChanges: false, pendingWorkAreaIds: [] })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '工事区域の取得に失敗しました',
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
    const name = `区域${existingAreas.length + 1}`

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

  addPoint: (workAreaId, coordinate) => {
    const area = get().getWorkAreaById(workAreaId)
    if (!area) return

    // 既に追加されている場合はスキップ
    if (area.pointIds.includes(coordinate.id)) return

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
      sortOrder: area.points.length,
    }

    set((state) => {
      const newWorkAreas = { ...state.workAreas }
      for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
        const areas = newWorkAreas[workType]
        if (!areas) continue
        const index = areas.findIndex(a => a.id === workAreaId)
        if (index !== -1) {
          const updatedAreas = [...areas]
          const areaToUpdate = { ...updatedAreas[index] }
          areaToUpdate.pointIds = [...areaToUpdate.pointIds, coordinate.id]
          areaToUpdate.points = [...areaToUpdate.points, newPoint]
          updatedAreas[index] = areaToUpdate
          newWorkAreas[workType] = updatedAreas
          break
        }
      }
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
  },

  removePoint: (workAreaId, coordinateId) => {
    set((state) => {
      const newWorkAreas = { ...state.workAreas }
      for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
        const areas = newWorkAreas[workType]
        if (!areas) continue
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[areaIndex] }
          area.pointIds = area.pointIds.filter(id => id !== coordinateId)
          area.points = area.points.filter(p => p.id !== coordinateId)
          // sortOrderを再割り当て
          area.points = area.points.map((p, i) => ({ ...p, sortOrder: i }))
          updatedAreas[areaIndex] = area
          newWorkAreas[workType] = updatedAreas
          break
        }
      }
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
  },

  reorderPoints: (workAreaId, coordinateIds) => {
    set((state) => {
      const newWorkAreas = { ...state.workAreas }
      for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
        const areas = newWorkAreas[workType]
        if (!areas) continue
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[areaIndex] }
          area.pointIds = coordinateIds
          const reorderedPoints = coordinateIds
            .map((id, index) => {
              const point = area.points.find(p => p.id === id)
              return point ? { ...point, sortOrder: index } : null
            })
            .filter((p): p is WorkAreaPoint => p !== null)
          area.points = reorderedPoints
          updatedAreas[areaIndex] = area
          newWorkAreas[workType] = updatedAreas
          break
        }
      }
      const newPending = state.pendingWorkAreaIds.includes(workAreaId)
        ? state.pendingWorkAreaIds
        : [...state.pendingWorkAreaIds, workAreaId]
      return { workAreas: newWorkAreas, hasChanges: true, pendingWorkAreaIds: newPending }
    })
  },

  calculateArea: (workAreaId) => {
    const area = get().getWorkAreaById(workAreaId)
    if (!area || area.points.length < 3) return null

    const points = area.points.map(p => ({
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
      const newWorkAreas = { ...state.workAreas }
      for (const workType of Object.keys(newWorkAreas) as WorkType[]) {
        const areas = newWorkAreas[workType]
        if (!areas) continue
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          updatedAreas[areaIndex] = {
            ...updatedAreas[areaIndex],
            areaSqm: sheet.area_sqm,
            areaHa: sheet.area_ha,
            perimeterM: sheet.perimeter_m,
          }
          newWorkAreas[workType] = updatedAreas
          break
        }
      }
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
