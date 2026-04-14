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

  // データ取得
  fetchWorkAreas: (farmId: string) => Promise<void>

  // 工事区域操作
  addWorkArea: (workType: WorkType) => Promise<WorkAreaRow | null>
  updateWorkArea: (id: string, updates: Partial<Pick<WorkAreaRow, 'zoneNumber' | 'name' | 'notes'>>) => void
  deleteWorkArea: (id: string) => Promise<void>

  // 座標点操作
  addPoint: (workAreaId: string, point: Omit<WorkAreaPoint, 'id' | 'lat' | 'lng' | 'sortOrder'>) => void
  updatePoint: (workAreaId: string, pointId: string, updates: Partial<WorkAreaPoint>) => void
  removePoint: (workAreaId: string, pointId: string) => void
  reorderPoints: (workAreaId: string, pointIds: string[]) => void
  importPointsFromTSV: (workAreaId: string, tsvData: string) => { success: boolean; count: number; error?: string }

  // 面積計算
  calculateArea: (workAreaId: string) => AreaCalculationSheet | null

  // 保存
  saveWorkArea: (id: string) => Promise<void>

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

// UUIDを生成
const generateId = (): string => {
  return crypto.randomUUID()
}

export const useWorkAreaStore = create<WorkAreaState>()((set, get) => ({
  workAreas: new Map(),
  loading: false,
  error: null,

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

      if (typedAreas.length === 0) {
        set({ workAreas: new Map(), loading: false })
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
            if (p.x && p.y) {
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

      set({ workAreas: workAreasMap, loading: false })
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
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      const updateData: Record<string, unknown> = {}
      if (updates.zoneNumber !== undefined) updateData.zone_number = updates.zoneNumber
      if (updates.name !== undefined) updateData.name = updates.name
      if (updates.notes !== undefined) updateData.notes = updates.notes

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from('design_work_areas')
          .update(updateData as never)
          .eq('id', id)
      }
    })()
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

  addPoint: (workAreaId, point) => {
    const zone = getCurrentZone()
    const converter = new CoordinateConverter(zone)
    let lat: number | null = null
    let lng: number | null = null
    if (point.x && point.y) {
      const result = converter.toLatLng(point.x, point.y)
      lat = result.lat
      lng = result.lng
    }

    const newPointId = generateId()

    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const index = areas.findIndex(a => a.id === workAreaId)
        if (index !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[index] }
          const newPoint: WorkAreaPoint = {
            id: newPointId,
            pointNumber: point.pointNumber,
            x: point.x,
            y: point.y,
            z: point.z,
            lat,
            lng,
            sortOrder: area.points.length,
          }
          area.points = [...area.points, newPoint]
          updatedAreas[index] = area
          newMap.set(workType, updatedAreas)
          break
        }
      }
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      const area = get().getWorkAreaById(workAreaId)
      if (!area) return

      await supabase
        .from('work_area_coordinates')
        .insert({
          id: newPointId,
          work_area_id: workAreaId,
          point_number: point.pointNumber,
          x: point.x,
          y: point.y,
          z: point.z,
          sort_order: area.points.length - 1,
        } as never)
    })()
  },

  updatePoint: (workAreaId, pointId, updates) => {
    const zone = getCurrentZone()
    const converter = new CoordinateConverter(zone)

    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const area = { ...updatedAreas[areaIndex] }
          const pointIndex = area.points.findIndex(p => p.id === pointId)
          if (pointIndex !== -1) {
            const updatedPoint = { ...area.points[pointIndex], ...updates }
            // 座標が更新された場合は緯度経度も再計算
            if (updates.x !== undefined || updates.y !== undefined) {
              const result = converter.toLatLng(updatedPoint.x, updatedPoint.y)
              updatedPoint.lat = result.lat
              updatedPoint.lng = result.lng
            }
            const newPoints = [...area.points]
            newPoints[pointIndex] = updatedPoint
            area.points = newPoints
            updatedAreas[areaIndex] = area
            newMap.set(workType, updatedAreas)
          }
          break
        }
      }
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      const updateData: Record<string, unknown> = {}
      if (updates.pointNumber !== undefined) updateData.point_number = updates.pointNumber
      if (updates.x !== undefined) updateData.x = updates.x
      if (updates.y !== undefined) updateData.y = updates.y
      if (updates.z !== undefined) updateData.z = updates.z
      if (updates.sortOrder !== undefined) updateData.sort_order = updates.sortOrder

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from('work_area_coordinates')
          .update(updateData as never)
          .eq('id', pointId)
      }
    })()
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
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      await supabase
        .from('work_area_coordinates')
        .delete()
        .eq('id', pointId)
    })()
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
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      for (let i = 0; i < pointIds.length; i++) {
        await supabase
          .from('work_area_coordinates')
          .update({ sort_order: i } as never)
          .eq('id', pointIds[i])
      }
    })()
  },

  importPointsFromTSV: (workAreaId, tsvData) => {
    const lines = tsvData.trim().split('\n')
    if (lines.length === 0) {
      return { success: false, count: 0, error: 'データがありません' }
    }

    const zone = getCurrentZone()
    const converter = new CoordinateConverter(zone)
    const area = get().getWorkAreaById(workAreaId)
    if (!area) {
      return { success: false, count: 0, error: '工事区域が見つかりません' }
    }

    const newPoints: WorkAreaPoint[] = []
    const startOrder = area.points.length

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      // タブまたはカンマで分割
      const parts = line.split(/[\t,]/).map(s => s.trim())

      // 最低2列（X, Y）または3列（点番, X, Y）または4列（点番, X, Y, Z）
      if (parts.length < 2) {
        continue
      }

      let pointNumber: string
      let x: number
      let y: number
      let z: number | null = null

      if (parts.length === 2) {
        // X, Y のみ
        pointNumber = `P${startOrder + newPoints.length + 1}`
        x = parseFloat(parts[0])
        y = parseFloat(parts[1])
      } else if (parts.length === 3) {
        // 点番, X, Y または X, Y, Z
        const firstIsNumber = !isNaN(parseFloat(parts[0])) && parts[0].match(/^[\d.-]+$/)
        if (firstIsNumber && !isNaN(parseFloat(parts[1])) && !isNaN(parseFloat(parts[2]))) {
          // X, Y, Z の場合
          pointNumber = `P${startOrder + newPoints.length + 1}`
          x = parseFloat(parts[0])
          y = parseFloat(parts[1])
          z = parseFloat(parts[2])
        } else {
          // 点番, X, Y の場合
          pointNumber = parts[0] || `P${startOrder + newPoints.length + 1}`
          x = parseFloat(parts[1])
          y = parseFloat(parts[2])
        }
      } else {
        // 4列以上: 点番, X, Y, Z
        pointNumber = parts[0] || `P${startOrder + newPoints.length + 1}`
        x = parseFloat(parts[1])
        y = parseFloat(parts[2])
        z = parts[3] ? parseFloat(parts[3]) : null
      }

      if (isNaN(x) || isNaN(y)) {
        continue
      }

      let lat: number | null = null
      let lng: number | null = null
      const result = converter.toLatLng(x, y)
      lat = result.lat
      lng = result.lng

      newPoints.push({
        id: generateId(),
        pointNumber,
        x,
        y,
        z: z !== null && !isNaN(z) ? z : null,
        lat,
        lng,
        sortOrder: startOrder + newPoints.length,
      })
    }

    if (newPoints.length === 0) {
      return { success: false, count: 0, error: '有効なデータがありません' }
    }

    // ローカル状態を更新
    set((state) => {
      const newMap = new Map(state.workAreas)
      for (const [workType, areas] of newMap) {
        const areaIndex = areas.findIndex(a => a.id === workAreaId)
        if (areaIndex !== -1) {
          const updatedAreas = [...areas]
          const updatedArea = { ...updatedAreas[areaIndex] }
          updatedArea.points = [...updatedArea.points, ...newPoints]
          updatedAreas[areaIndex] = updatedArea
          newMap.set(workType, updatedAreas)
          break
        }
      }
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      const insertData = newPoints.map(p => ({
        id: p.id,
        work_area_id: workAreaId,
        point_number: p.pointNumber,
        x: p.x,
        y: p.y,
        z: p.z,
        sort_order: p.sortOrder,
      }))

      await supabase
        .from('work_area_coordinates')
        .insert(insertData as never)
    })()

    return { success: true, count: newPoints.length }
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
      return { workAreas: newMap }
    })

    // Supabaseに同期
    ;(async () => {
      await supabase
        .from('design_work_areas')
        .update({
          area_sqm: sheet.area_sqm,
          area_ha: sheet.area_ha,
          perimeter_m: sheet.perimeter_m,
        } as never)
        .eq('id', workAreaId)
    })()

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
          id: p.id,
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
