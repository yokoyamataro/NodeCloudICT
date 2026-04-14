import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'

export interface Farm {
  id: string
  user_id: string
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

interface FarmState {
  // 圃場一覧
  farms: Farm[]
  loading: boolean
  error: string | null

  // 圃場の位置情報（先頭座標）
  farmLocations: Map<string, FarmLocation>

  // 現在の圃場
  currentFarm: Farm | null
  setCurrentFarm: (farm: Farm | null) => void

  // CRUD操作
  fetchFarms: () => Promise<void>
  fetchFarmLocations: () => Promise<void>
  createFarm: (name: string, description?: string, coordinateZone?: number) => Promise<Farm | null>
  updateFarm: (id: string, updates: Partial<Pick<Farm, 'name' | 'description' | 'coordinate_zone'>>) => Promise<void>
  deleteFarm: (id: string) => Promise<void>
}

export const useFarmStore = create<FarmState>((set, get) => ({
  farms: [],
  loading: false,
  error: null,
  currentFarm: null,
  farmLocations: new Map(),

  setCurrentFarm: (farm) => set({ currentFarm: farm }),

  fetchFarms: async () => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('farms')
        .select('*')
        .order('updated_at', { ascending: false })

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

  createFarm: async (name, description, coordinateZone = 6) => {
    set({ loading: true, error: null })
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('ログインが必要です')

      const insertData = {
        user_id: user.id,
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
