import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'
import { useMapViewStore } from './mapViewStore'
import { useProjectListStore } from './projectListStore'

export interface Farm {
  id: string
  user_id: string
  project_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

// 工区の先頭座標情報
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

// プロジェクトIDから座標系を取得（projectListStore を優先し、不足分はDBから補完）
async function fetchProjectZones(projectIds: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(projectIds))
  const zones = new Map<string, number>()

  // まずストアから取得
  const storeProjects = useProjectListStore.getState().projects
  const missing: string[] = []
  for (const id of unique) {
    const proj = storeProjects.find((p) => p.id === id)
    if (proj) {
      zones.set(id, proj.coordinate_zone)
    } else {
      missing.push(id)
    }
  }

  // ストアに無いものだけDBから取得
  if (missing.length > 0) {
    const { data, error } = await supabase
      .from('projects')
      .select('id, coordinate_zone')
      .in('id', missing)
    if (!error && data) {
      const rows = data as Array<{ id: string; coordinate_zone: number }>
      for (const row of rows) {
        zones.set(row.id, row.coordinate_zone)
      }
    }
  }

  return zones
}

interface FarmState {
  // 工区一覧
  farms: Farm[]
  loading: boolean
  error: string | null

  // 工区の位置情報（先頭座標）
  farmLocations: Map<string, FarmLocation>

  // 工事区域ポリゴン
  workAreaPolygons: WorkAreaPolygon[]

  // 現在の工区
  currentFarm: Farm | null
  setCurrentFarm: (farm: Farm | null) => void

  // CRUD操作
  fetchFarms: (projectId?: string) => Promise<void>
  fetchFarmLocations: () => Promise<void>
  fetchWorkAreaPolygons: () => Promise<void>
  createFarm: (projectId: string, name: string, description?: string) => Promise<Farm | null>
  updateFarm: (id: string, updates: Partial<Pick<Farm, 'name' | 'description'>>) => Promise<void>
  deleteFarm: (id: string) => Promise<void>
}

export const useFarmStore = create<FarmState>((set, get) => ({
  farms: [],
  loading: false,
  error: null,
  currentFarm: null,
  farmLocations: new Map(),
  workAreaPolygons: [],

  setCurrentFarm: (farm) => {
    // 工区が変わったら地図の表示状態をリセット（座標にフィットさせる）
    const currentFarm = get().currentFarm
    if (farm?.id !== currentFarm?.id) {
      useMapViewStore.getState().resetView()
    }
    set({ currentFarm: farm })
  },

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
      set({ error: err instanceof Error ? err.message : '工区の取得に失敗しました', loading: false })
    }
  },

  fetchFarmLocations: async () => {
    const { farms } = get()
    if (farms.length === 0) return

    try {
      // 各工区の先頭座標を取得
      const { data, error } = await supabase
        .from('design_coordinates')
        .select('id, farm_id, point_number, x, y')
        .in('farm_id', farms.map(f => f.id))
        .order('point_number')

      if (error) throw error

      // プロジェクトごとの座標系を取得
      const projectZones = await fetchProjectZones(farms.map(f => f.project_id))

      // 工区ごとに先頭の座標を取得
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
          const zone = projectZones.get(farm.project_id) ?? 13
          const converter = new CoordinateConverter(zone)
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
        // design_work_areasのpoint_idsを取得
        const { data: areasWithPointIds, error: pointIdsError } = await supabase
          .from('design_work_areas')
          .select('id, point_ids')
          .in('id', areas.map(a => a.id))

        if (pointIdsError) throw pointIdsError

        const areasPointIds = areasWithPointIds as Array<{
          id: string
          point_ids: string[] | null
        }> | null

        // design_coordinates は work_area が属する各 farm_id 単位でページング取得する
        // （in('id', [...uuids]) は URL 長 + 1000 行上限の問題があるため使わない）
        const coordsMap: Record<string, { x: number; y: number }> = {}
        const farmIdsWithAreas = new Set(areas.map(a => a.farm_id))
        const PAGE = 1000
        for (const fid of farmIdsWithAreas) {
          let from = 0
          while (from < 1_000_000) {
            const { data: coordsData, error: coordError } = await supabase
              .from('design_coordinates')
              .select('id, x, y')
              .eq('farm_id', fid)
              .range(from, from + PAGE - 1)
            if (coordError) throw coordError
            const rows = (coordsData || []) as Array<{ id: string; x: number; y: number }>
            for (const c of rows) coordsMap[c.id] = { x: c.x, y: c.y }
            if (rows.length < PAGE) break
            from += PAGE
          }
        }

        // プロジェクトごとの座標系を取得
        const projectZones = await fetchProjectZones(farms.map(f => f.project_id))

        for (const area of areas) {
          const farm = farms.find(f => f.id === area.farm_id)
          if (!farm) continue

          const areaPointIds = areasPointIds?.find(a => a.id === area.id)?.point_ids || []
          if (areaPointIds.length < 3) continue

          const zone = projectZones.get(farm.project_id) ?? 13
          const converter = new CoordinateConverter(zone)
          const positions: [number, number][] = []

          for (const pointId of areaPointIds) {
            const coord = coordsMap[pointId]
            if (coord) {
              const { lat, lng } = converter.toLatLng(coord.x, coord.y)
              positions.push([lat, lng])
            }
          }

          if (positions.length < 3) continue

          polygons.push({
            id: area.id,
            farmId: area.farm_id,
            workType: area.work_type,
            name: area.name || area.zone_number || '',
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

  createFarm: async (projectId, name, description) => {
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
      set({ error: err instanceof Error ? err.message : '工区の作成に失敗しました', loading: false })
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
      set({ error: err instanceof Error ? err.message : '工区の更新に失敗しました', loading: false })
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
      set({ error: err instanceof Error ? err.message : '工区の削除に失敗しました', loading: false })
    }
  },
}))
