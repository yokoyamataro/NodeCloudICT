import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from './farmStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { generateAreaCalculationSheet } from '@/lib/area-calculation'
import type { WorkType, AreaCalculationSheet, DesignWorkArea, WorkAreaCoordinate } from '@/types/database'

// 工事区域の座標点
export interface WorkAreaPoint {
  id: string
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
  points: WorkAreaPoint[]
  areaSqm: number | null
  areaHa: number | null
  perimeterM: number | null
  notes: string | null
}

interface WorkAreaState {
  // 工事区域データ（工種別）
  workAreas: Map<WorkType, WorkAreaRow[]>
  loading: boolean
  error: string | null

  // 変更追跡
  hasChanges: boolean
  pendingWorkAreaIds: Set<string>

  // データ取得
  fetchWorkAreas: (farmId: string) => Promise<void>

  // 工事区域操作
  addWorkArea: (workType: WorkType) => Promise<WorkAreaRow | null>
  updateWorkArea: (id: string, updates: Partial<Pick<WorkAreaRow, 'zoneNumber' | 'name' | 'notes'>>) => void
  deleteWorkArea: (id: string) => Promise<void>

  // 座標点操作（座標管理の座標を選択して追加）
  addPointFromCoordinate: (workAreaId: string, pointNumber: string, x: number, y: number, z: number | null) => void
  removePoint: (workAreaId: string, pointId: string) => void
  reorderPoints: (workAreaId: string, pointIds: string[]) => void

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

// 圃場IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
}

// 座標系を取得するヘルパー
const getCurrentZone = (): number => {
  return useFarmStore.getState().currentFarm?.coordinate_zone ?? 6
}

export const useWorkAreaStore = create<WorkAreaState>()((set, get) => ({
  workAreas: new Map(),
  loading: false,
  error: null,
  hasChanges: false,
  pendingWorkAreaIds: new Set(),

  fetchWorkAreas: async (farmId: string) => {
    set({ loading: true, error: null })
    try {
      // 工事区域を取得
      const { data: areas, error: areaError } = await supabase
        .from('design_work_areas')
        .select('*')
        .eq('farm_id', farmId)
        .order('work_type')
        .order('zone_number')

      if (areaError) throw areaError

      const typedAreas = areas as DesignWorkArea[]

      console.log('[workAreaStore] fetchWorkAreas - areas from DB:', {
        farmId,
        areasCount: typedAreas.length,
        areas: typedAreas.map(a => ({ id: a.id, work_type: a.work_type, name: a.name })),
      })

      if (typedAreas.length === 0) {
        set({ workAreas: new Map(), loading: false, hasChanges: false, pendingWorkAreaIds: new Set() })
        return
      }

      // 全エリアのIDを取得
      const areaIds = typedAreas.map(a => a.id)

      // 各エリアの座標点を取得
      const { data: points, error: pointError } = await supabase
        .from('work_area_coordinates')
        .select('*')
        .in('work_area_id', areaIds)
        .order('sort_order')

      if (pointError) throw pointError

      const typedPoints = (points || []) as WorkAreaCoordinate[]

      const zone = getCurrentZone()
      const converter = new CoordinateConverter(zone)

      // 工種別にグループ化
      const workAreasMap = new Map<WorkType, WorkAreaRow[]>()

      for (const area of typedAreas) {
        const areaPoints = typedPoints
          .filter(p => p.work_area_id === area.id)
          .map(p => {
            let lat: number | null = null
            let lng: number | null = null
            if (p.x !== null && p.x !== undefined && p.y !== null && p.y !== undefined) {
              const result = converter.toLatLng(p.x, p.y)
              lat = result.lat
              lng = result.lng
            }
            return {
              id: p.id,
              pointNumber: p.point_number,
              x: p.x,
              y: p.y,
              z: p.z,
              lat,
              lng,
              sortOrder: p.sort_order,
            }
          })

        const workAreaRow: WorkAreaRow = {
          id: area.id,
          workType: area.work_type,
          zoneNumber: area.zone_number,
          name: area.name,
          points: areaPoints,
          areaSqm: area.area_sqm,
          areaHa: area.area_ha,
          perimeterM: area.perimeter_m,
          notes: area.notes,
        }

        const existing = workAreasMap.get(area.work_type) || []
        existing.push(workAreaRow)
        workAreasMap.set(area.work_type, existing)
      }

      console.log('[workAreaStore] fetchWorkAreas result:', {
        farmId,
        areasCount: typedAreas.length,
        pointsCount: typedPoints.length,
        workAreasMap: Object.fromEntries(
          Array.from(workAreasMap.entries()).map(([k, v]) => [k, v.map(a => ({ id: a.id, name: a.name, pointsCount: a.points.length }))])
        ),
      })
      set({ workAreas: workAreasMap, loading: false, hasChanges: false, pendingWorkAreaIds: new Set() })
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
      set({ error: '圃場が選択されていません' })
      return null
    }

    const state = get()
    const existingAreas = state.workAreas.get(workType) || []
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
        points: [],
        areaSqm: null,
        areaHa: null,
        perimeterM: null,
        notes: null,
      }

      set((state) => {
        const newMap = new Map(state.workAreas)
        const existing = newMap.get(workType) || []
        newMap.set(workType, [...existing, newArea])
        return { workAreas: newMap }
      })

      return newArea
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工事区域の作成に失敗しました' })
      return null
    }
  },

  updateWorkArea: (id, updates) => {
    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const index = areas.findIndex(a => a.id === id)
        if (index !== -1) {
          const updatedAreas = [...areas]
          updatedAreas[index] = { ...updatedAreas[index], ...updates }
          newMap.set(workType, updatedAreas)
          break
        }
      }
      const newPending = new Set(state.pendingWorkAreaIds)
      newPending.add(id)
      return { workAreas: newMap, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 明示的にsaveWorkAreaを呼び出すまでSupabaseには保存しない
  },

  deleteWorkArea: async (id) => {
    try {
      // 座標点を削除
      await supabase
        .from('work_area_coordinates')
        .delete()
        .eq('work_area_id', id)

      // 工事区域を削除
      const { error } = await supabase
        .from('design_work_areas')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => {
        const newMap = new Map(state.workAreas)
        for (const [workType, areas] of newMap) {
          const filtered = areas.filter(a => a.id !== id)
          if (filtered.length !== areas.length) {
            newMap.set(workType, filtered)
            break
          }
        }
        return { workAreas: newMap }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工事区域の削除に失敗しました' })
    }
  },

  addPointFromCoordinate: (workAreaId, pointNumber, x, y, z) => {
    const zone = getCurrentZone()
    const converter = new CoordinateConverter(zone)
    let lat: number | null = null
    let lng: number | null = null
    if (x !== null && x !== undefined && y !== null && y !== undefined) {
      const result = converter.toLatLng(x, y)
      lat = result.lat
      lng = result.lng
    }

    const area = get().getWorkAreaById(workAreaId)
    if (!area) return

    // 同じ座標点番号が既に追加されている場合はスキップ
    if (area.points.some(p => p.pointNumber === pointNumber)) return

    const sortOrder = area.points.length
    // 新しいIDを生成（座標IDとは別にwork_area_coordinates用のID）
    const newPointId = crypto.randomUUID()

    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const index = areas.findIndex(a => a.id === workAreaId)
        if (index !== -1) {
          const updatedAreas = [...areas]
          const areaToUpdate = { ...updatedAreas[index] }
          const newPoint: WorkAreaPoint = {
            id: newPointId,
            pointNumber,
            x,
            y,
            z,
            lat,
            lng,
            sortOrder,
          }
          areaToUpdate.points = [...areaToUpdate.points, newPoint]
          updatedAreas[index] = areaToUpdate
          newMap.set(workType, updatedAreas)
          break
        }
      }
      const newPending = new Set(state.pendingWorkAreaIds)
      newPending.add(workAreaId)
      return { workAreas: newMap, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 明示的にsaveWorkAreaを呼び出すまでSupabaseには保存しない
  },

  removePoint: (workAreaId, pointId) => {
    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[areaIndex] }
          area.points = area.points.filter(p => p.id !== pointId)
          // sortOrderを再割り当て
          area.points = area.points.map((p, i) => ({ ...p, sortOrder: i }))
          updatedAreas[areaIndex] = area
          newMap.set(workType, updatedAreas)
          break
        }
      }
      const newPending = new Set(state.pendingWorkAreaIds)
      newPending.add(workAreaId)
      return { workAreas: newMap, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 明示的にsaveWorkAreaを呼び出すまでSupabaseには保存しない
  },

  reorderPoints: (workAreaId, pointIds) => {
    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[areaIndex] }
          const reorderedPoints = pointIds
            .map((id, index) => {
              const point = area.points.find(p => p.id === id)
              return point ? { ...point, sortOrder: index } : null
            })
            .filter((p): p is WorkAreaPoint => p !== null)
          area.points = reorderedPoints
          updatedAreas[areaIndex] = area
          newMap.set(workType, updatedAreas)
          break
        }
      }
      const newPending = new Set(state.pendingWorkAreaIds)
      newPending.add(workAreaId)
      return { workAreas: newMap, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 明示的にsaveWorkAreaを呼び出すまでSupabaseには保存しない
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
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          updatedAreas[areaIndex] = {
            ...updatedAreas[areaIndex],
            areaSqm: sheet.area_sqm,
            areaHa: sheet.area_ha,
            perimeterM: sheet.perimeter_m,
          }
          newMap.set(workType, updatedAreas)
          break
        }
      }
      const newPending = new Set(state.pendingWorkAreaIds)
      newPending.add(workAreaId)
      return { workAreas: newMap, hasChanges: true, pendingWorkAreaIds: newPending }
    })
    // 明示的にsaveWorkAreaを呼び出すまでSupabaseには保存しない

    return sheet
  },

  saveWorkArea: async (id) => {
    const area = get().getWorkAreaById(id)
    if (!area) return

    try {
      // 工事区域を更新
      await supabase
        .from('design_work_areas')
        .update({
          zone_number: area.zoneNumber,
          name: area.name,
          area_sqm: area.areaSqm,
          area_ha: area.areaHa,
          perimeter_m: area.perimeterM,
          notes: area.notes,
        } as never)
        .eq('id', id)

      // 座標点を全削除して再挿入
      await supabase
        .from('work_area_coordinates')
        .delete()
        .eq('work_area_id', id)

      if (area.points.length > 0) {
        const insertData = area.points.map(p => ({
          work_area_id: id,
          point_number: p.pointNumber,
          x: p.x,
          y: p.y,
          z: p.z,
          sort_order: p.sortOrder,
        }))

        await supabase
          .from('work_area_coordinates')
          .insert(insertData as never)
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存に失敗しました' })
    }
  },

  saveAllWorkAreas: async () => {
    const state = get()
    const pendingIds = Array.from(state.pendingWorkAreaIds)
    for (const id of pendingIds) {
      await get().saveWorkArea(id)
    }
    set({ hasChanges: false, pendingWorkAreaIds: new Set() })
  },

  resetWorkAreaChanges: () => {
    // 変更フラグをリセット（データは再フェッチで復元）
    const farmId = getCurrentFarmId()
    set({ hasChanges: false, pendingWorkAreaIds: new Set() })
    if (farmId) {
      get().fetchWorkAreas(farmId)
    }
  },

  getWorkAreasByType: (workType) => {
    return get().workAreas.get(workType) || []
  },

  getWorkAreaById: (id) => {
    for (const areas of get().workAreas.values()) {
      const found = areas.find(a => a.id === id)
      if (found) return found
    }
    return undefined
  },
}))
