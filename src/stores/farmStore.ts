import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'

export interface Farm {
  id: string
  user_id: string
  project_id: string
  name: string
  description: string | null
  coordinate_zone: number
  created_at: string
  updated_at: string
}

// 圃場の先頭座標情報
export interface FarmLocation {
  farmId: string
  lat: number
  lng: number
  pointNumber: string
}

// 工事区域のポリゴン情報
export interface WorkAreaPolygon {
  id: string
  farmId: string
  workType: string
  name: string
  positions: [number, number][]
}

interface FarmState {
  // 圃場一覧
  farms: Farm[]
  loading: boolean
  error: string | null

  // 圃場の位置情報（先頭座標）
  farmLocations: Map<string, FarmLocation>

  // 工事区域ポリゴン
  workAreaPolygons: WorkAreaPolygon[]

  // 現在の圃場
  currentFarm: Farm | null
  setCurrentFarm: (farm: Farm | null) => void

  // CRUD操作
  fetchFarms: (projectId?: string) => Promise<void>
  fetchFarmLocations: () => Promise<void>
  fetchWorkAreaPolygons: () => Promise<void>
  createFarm: (projectId: string, name: string, description?: string, coordinateZone?: number) => Promise<Farm | null>
  updateFarm: (id: string, updates: Partial<Pick<Farm, 'name' | 'description' | 'coordinate_zone'>>) => Promise<void>
  deleteFarm: (id: string) => Promise<void>
}

export const useFarmStore = create<FarmState>((set, get) => ({
  farms: [],
  loading: false,
  error: null,
  currentFarm: null,
  farmLocations: new Map(),
  workAreaPolygons: [],

  setCurrentFarm: (farm) => set({ currentFarm: farm }),

  fetchFarms: async (projectId?: string) => {
    set({ loading: true, error: null })
    try {
      let query = supabase
        .from('farms')
        .select('*')
        .order('updated_at', { ascending: false })

      if (projectId) {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query

      if (error) throw error
      set({ farms: data || [], loading: false })

      // 位置情報も取得
      get().fetchFarmLocations()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '圃場の取得に失敗しました', loading: false })
    }
  },

  fetchFarmLocations: async () => {
    const { farms } = get()
    if (farms.length === 0) return

    try {
      // 各圃場の先頭座標を取得
      const { data, error } = await supabase
        .from('design_coordinates')
        .select('id, farm_id, point_number, x, y')
        .in('farm_id', farms.map(f => f.id))
        .order('point_number')

      if (error) throw error

      // 圃場ごとに先頭の座標を取得
      const locations = new Map<string, FarmLocation>()
      const coordData = data as Array<{
        id: string
        farm_id: string
        point_number: string
        x: number
        y: number
      }> | null

      for (const farm of farms) {
        const coords = (coordData || []).filter(c => c.farm_id === farm.id)
        if (coords.length > 0) {
          const firstCoord = coords[0]
          const converter = new CoordinateConverter(farm.coordinate_zone)
          const { lat, lng } = converter.toLatLng(firstCoord.x, firstCoord.y)
          locations.set(farm.id, {
            farmId: farm.id,
            lat,
            lng,
            pointNumber: firstCoord.point_number,
          })
        }
      }

      set({ farmLocations: locations })
    } catch (err) {
      console.error('位置情報の取得に失敗:', err)
    }
  },

  fetchWorkAreaPolygons: async () => {
    const { farms } = get()
    if (farms.length === 0) {
      set({ workAreaPolygons: [] })
      return
    }

    try {
      const polygons: WorkAreaPolygon[] = []

      // 1. design_work_areas から工事区域を取得（客土、整地など）
      const { data: areasData, error: areaError } = await supabase
        .from('design_work_areas')
        .select('id, farm_id, work_type, zone_number, name')
        .in('farm_id', farms.map(f => f.id))

      if (areaError) throw areaError

      const areas = areasData as Array<{
        id: string
        farm_id: string
        work_type: string
        zone_number: string
        name: string | null
      }> | null

      if (areas && areas.length > 0) {
        // 座標を取得
        const { data: coordsData, error: coordError } = await supabase
          .from('work_area_coordinates')
          .select('id, work_area_id, x, y, sort_order')
          .in('work_area_id', areas.map(a => a.id))
          .order('sort_order')

        if (coordError) throw coordError

        const coords = coordsData as Array<{
          id: string
          work_area_id: string
          x: number
          y: number
          sort_order: number
        }> | null

        for (const area of areas) {
          const farm = farms.find(f => f.id === area.farm_id)
          if (!farm) continue

          const areaCoords = (coords || [])
            .filter(c => c.work_area_id === area.id)
            .sort((a, b) => a.sort_order - b.sort_order)

          if (areaCoords.length < 3) continue

          const converter = new CoordinateConverter(farm.coordinate_zone)
          const positions: [number, number][] = areaCoords.map(c => {
            const { lat, lng } = converter.toLatLng(c.x, c.y)
            return [lat, lng] as [number, number]
          })

          polygons.push({
            id: area.id,
            farmId: area.farm_id,
            workType: area.work_type,
            name: area.name || area.zone_number || '',
            positions,
          })
        }
      }

      // 2. design_zones から暗渠の区域を取得
      const { data: zonesData, error: zoneError } = await supabase
        .from('design_zones')
        .select('id, farm_id, zone_number, name, point_ids')
        .in('farm_id', farms.map(f => f.id))

      if (zoneError) throw zoneError

      const zones = zonesData as Array<{
        id: string
        farm_id: string
        zone_number: string
        name: string | null
        point_ids: string[] | null
      }> | null

      if (zones && zones.length > 0) {
        // 各圃場の座標を取得
        const { data: coordsData, error: coordError } = await supabase
          .from('design_coordinates')
          .select('id, farm_id, x, y')
          .in('farm_id', farms.map(f => f.id))

        if (coordError) throw coordError

        const allCoords = coordsData as Array<{
          id: string
          farm_id: string
          x: number
          y: number
        }> | null

        for (const zone of zones) {
          const farm = farms.find(f => f.id === zone.farm_id)
          if (!farm) continue

          const pointIds = zone.point_ids || []
          if (pointIds.length < 3) continue

          const farmCoords = (allCoords || []).filter(c => c.farm_id === farm.id)
          const converter = new CoordinateConverter(farm.coordinate_zone)

          const positions: [number, number][] = []
          for (const pointId of pointIds) {
            const coord = farmCoords.find(c => c.id === pointId)
            if (coord) {
              const { lat, lng } = converter.toLatLng(coord.x, coord.y)
              positions.push([lat, lng])
            }
          }

          if (positions.length < 3) continue

          polygons.push({
            id: zone.id,
            farmId: zone.farm_id,
            workType: 'underdrain', // 暗渠工事
            name: zone.name || zone.zone_number || '',
            positions,
          })
        }
      }

      set({ workAreaPolygons: polygons })
    } catch (err) {
      console.error('工事区域ポリゴンの取得に失敗:', err)
      set({ workAreaPolygons: [] })
    }
  },

  createFarm: async (projectId, name, description, coordinateZone = 6) => {
    set({ loading: true, error: null })
    try {
      // 現在のユーザーIDを取得
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        throw new Error('ユーザー認証情報を取得できませんでした')
      }

      const insertData = {
        user_id: user.id,
        project_id: projectId,
        name,
        description: description || null,
        coordinate_zone: coordinateZone,
      }

      const { data, error } = await supabase
        .from('farms')
        .insert(insertData as never)
        .select()
        .single()

      if (error) throw error

      set((state) => ({
        farms: [data, ...state.farms],
        loading: false,
      }))

      return data
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '圃場の作成に失敗しました', loading: false })
      return null
    }
  },

  updateFarm: async (id, updates) => {
    set({ loading: true, error: null })
    try {
      const { error } = await supabase
        .from('farms')
        .update(updates as never)
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        farms: state.farms.map((f) =>
          f.id === id ? { ...f, ...updates } : f
        ),
        currentFarm: state.currentFarm?.id === id
          ? { ...state.currentFarm, ...updates }
          : state.currentFarm,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '圃場の更新に失敗しました', loading: false })
    }
  },

  deleteFarm: async (id) => {
    set({ loading: true, error: null })
    try {
      const { error } = await supabase
        .from('farms')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        farms: state.farms.filter((f) => f.id !== id),
        currentFarm: state.currentFarm?.id === id ? null : state.currentFarm,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '圃場の削除に失敗しました', loading: false })
    }
  },
}))
