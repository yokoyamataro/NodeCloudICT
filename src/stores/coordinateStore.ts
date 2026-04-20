import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { CoordinateType, DesignCoordinate } from '@/types/database'
import { CoordinateConverter } from '@/lib/coordinates'
import { useFarmStore } from './farmStore'
import { useSettingsStore } from './settingsStore'

// ローカル状態用の座標型
export interface CoordinateRow {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
  lat: number | null
  lng: number | null
  type: CoordinateType
}

// 経路（順路）の方向
export type RouteDirection = 'up' | 'down'

// 経路の1点
export interface RoutePoint {
  coordinateId: string
  direction: RouteDirection
}

interface CoordinateState {
  // 座標系設定
  zone: number
  setZone: (zone: number) => void

  // 座標データ
  coordinates: CoordinateRow[]
  loading: boolean
  error: string | null
  fetchCoordinates: (farmId: string) => Promise<void>
  addCoordinate: (type: CoordinateType) => Promise<void>
  updateCoordinate: (id: string, field: keyof CoordinateRow, value: string | number | null) => void
  deleteCoordinate: (id: string) => Promise<void>
  importCoordinates: (coords: Omit<CoordinateRow, 'id' | 'lat' | 'lng'>[]) => Promise<void>
  clearCoordinates: () => Promise<void>
  getCoordinateById: (id: string) => CoordinateRow | undefined

  // フィルタリング
  selectedType: CoordinateType
  setSelectedType: (type: CoordinateType) => void
  getFilteredCoordinates: () => CoordinateRow[]

  // 手動保存モード用
  pendingChanges: Map<string, CoordinateRow>
  saveAllCoordinates: () => Promise<void>
  resetCoordinateChanges: () => void

  // 経路（順路）
  route: RoutePoint[]
  routeHasChanges: boolean
  fetchRoute: (farmId: string) => Promise<void>
  appendRoutePoint: (coordinateId: string, direction?: RouteDirection) => void
  removeRoutePoint: (index: number) => void
  setRouteDirection: (index: number, direction: RouteDirection) => void
  moveRoutePoint: (index: number, offset: number) => void
  clearRoute: () => void
  saveRoute: () => Promise<void>
}

// 圃場IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
}

export const useCoordinateStore = create<CoordinateState>()((set, get) => ({
  // 座標系設定
  zone: 9, // デフォルト: 第9系（関東）
  setZone: (zone) => {
    const converter = new CoordinateConverter(zone)
    // 座標系が変更されたら、すべての緯度経度を再計算
    set((state) => ({
      zone,
      coordinates: state.coordinates.map((coord) => {
        if (coord.x && coord.y) {
          const { lat, lng } = converter.toLatLng(coord.x, coord.y)
          return { ...coord, lat, lng }
        }
        return coord
      }),
    }))
  },

  // 座標データ
  coordinates: [],
  loading: false,
  error: null,

  fetchCoordinates: async (farmId: string) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('design_coordinates')
        .select('*')
        .eq('farm_id', farmId)
        .order('point_number')

      if (error) throw error

      const zone = get().zone
      const converter = new CoordinateConverter(zone)

      const coordinates: CoordinateRow[] = ((data || []) as DesignCoordinate[]).map((row) => {
        let lat = row.latitude
        let lng = row.longitude
        if (lat === null || lng === null) {
          const result = converter.toLatLng(row.x, row.y)
          lat = result.lat
          lng = result.lng
        }
        return {
          id: row.id,
          pointNumber: row.point_number,
          x: row.x,
          y: row.y,
          z: row.z,
          lat,
          lng,
          type: row.coordinate_type as CoordinateType,
        }
      })

      set({ coordinates, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標の取得に失敗しました', loading: false })
    }
  },

  addCoordinate: async (type) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '圃場が選択されていません' })
      return
    }

    const state = get()
    const pointNumber = `P${state.coordinates.length + 1}`

    try {
      const { data, error } = await supabase
        .from('design_coordinates')
        .insert({
          farm_id: farmId,
          point_number: pointNumber,
          x: 0,
          y: 0,
          z: null,
          coordinate_type: type,
          latitude: null,
          longitude: null,
        } as never)
        .select()
        .single()

      if (error) throw error

      const row = data as DesignCoordinate
      const newCoord: CoordinateRow = {
        id: row.id,
        pointNumber: row.point_number,
        x: row.x,
        y: row.y,
        z: row.z,
        lat: null,
        lng: null,
        type: row.coordinate_type as CoordinateType,
      }

      set({ coordinates: [...state.coordinates, newCoord] })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標の追加に失敗しました' })
    }
  },

  updateCoordinate: (id, field, value) => {
    const state = get()
    const converter = new CoordinateConverter(state.zone)
    const coord = state.coordinates.find((c) => c.id === id)
    if (!coord) return

    const updated = { ...coord, [field]: value }

    // X, Y が更新されたら緯度経度を再計算
    if (field === 'x' || field === 'y') {
      if (updated.x && updated.y) {
        const { lat, lng } = converter.toLatLng(updated.x, updated.y)
        updated.lat = lat
        updated.lng = lng
      }
    }

    // ローカル状態を即座に更新
    set({
      coordinates: state.coordinates.map((c) => (c.id === id ? updated : c)),
    })

    // 保存モードをチェック
    const saveMode = useSettingsStore.getState().saveMode
    if (saveMode === 'manual') {
      // 手動保存モード: 変更を記録
      const newPendingChanges = new Map(state.pendingChanges)
      newPendingChanges.set(id, updated)
      set({ pendingChanges: newPendingChanges })
      useSettingsStore.getState().setHasUnsavedChanges(true)
    } else {
      // 自動保存モード: 即座にSupabaseに保存
      const dbField = field === 'pointNumber' ? 'point_number' : field === 'type' ? 'coordinate_type' : field
      const updateData: Record<string, unknown> = { [dbField]: value }
      if (field === 'x' || field === 'y') {
        updateData.latitude = updated.lat
        updateData.longitude = updated.lng
      }

      supabase
        .from('design_coordinates')
        .update(updateData as never)
        .eq('id', id)
        .then(({ error }) => {
          if (error) {
            set({ error: error.message })
          }
        })
    }
  },

  deleteCoordinate: async (id) => {
    try {
      const { error } = await supabase
        .from('design_coordinates')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        coordinates: state.coordinates.filter((c) => c.id !== id),
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標の削除に失敗しました' })
    }
  },

  importCoordinates: async (coords) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '圃場が選択されていません' })
      return
    }

    const state = get()
    const converter = new CoordinateConverter(state.zone)

    try {
      const insertData = coords.map((c) => {
        let lat: number | null = null
        let lng: number | null = null
        if (c.x && c.y) {
          const result = converter.toLatLng(c.x, c.y)
          lat = result.lat
          lng = result.lng
        }
        return {
          farm_id: farmId,
          point_number: c.pointNumber,
          x: c.x,
          y: c.y,
          z: c.z,
          coordinate_type: c.type,
          latitude: lat,
          longitude: lng,
        }
      })

      const { data, error } = await supabase
        .from('design_coordinates')
        .insert(insertData as never)
        .select()

      if (error) throw error

      const newCoords: CoordinateRow[] = ((data || []) as DesignCoordinate[]).map((row) => ({
        id: row.id,
        pointNumber: row.point_number,
        x: row.x,
        y: row.y,
        z: row.z,
        lat: row.latitude,
        lng: row.longitude,
        type: row.coordinate_type as CoordinateType,
      }))

      set({ coordinates: [...state.coordinates, ...newCoords] })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標のインポートに失敗しました' })
    }
  },

  clearCoordinates: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return

    try {
      // 座標を全削除
      const { error: coordError } = await supabase
        .from('design_coordinates')
        .delete()
        .eq('farm_id', farmId)

      if (coordError) throw coordError

      set({ coordinates: [] })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'データの削除に失敗しました' })
    }
  },

  getCoordinateById: (id) => {
    return get().coordinates.find((c) => c.id === id)
  },

  // フィルタリング
  selectedType: 'control',
  setSelectedType: (type) => set({ selectedType: type }),

  getFilteredCoordinates: () => {
    const state = get()
    return state.coordinates.filter((c) => c.type === state.selectedType)
  },

  // 手動保存モード用
  pendingChanges: new Map(),

  saveAllCoordinates: async () => {
    const state = get()
    const farmId = getCurrentFarmId()
    if (!farmId) return

    try {
      // 座標の変更を保存
      for (const [id, coord] of state.pendingChanges) {
        const { error } = await supabase
          .from('design_coordinates')
          .update({
            point_number: coord.pointNumber,
            x: coord.x,
            y: coord.y,
            z: coord.z,
            coordinate_type: coord.type,
            latitude: coord.lat,
            longitude: coord.lng,
          } as never)
          .eq('id', id)

        if (error) throw error
      }

      // 変更をクリア
      set({ pendingChanges: new Map() })
      useSettingsStore.getState().setHasUnsavedChanges(false)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存に失敗しました' })
    }
  },

  resetCoordinateChanges: () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return

    // Supabaseから再読み込み
    get().fetchCoordinates(farmId)

    // 変更をクリア
    set({ pendingChanges: new Map() })
    useSettingsStore.getState().setHasUnsavedChanges(false)
  },

  // 経路（順路）
  route: [] as RoutePoint[],
  routeHasChanges: false,

  fetchRoute: async (farmId: string) => {
    try {
      const { data, error } = await supabase
        .from('design_coordinate_routes')
        .select('coordinate_id, direction, sort_order')
        .eq('farm_id', farmId)
        .order('sort_order', { ascending: true })

      if (error) throw error

      const route = ((data || []) as Array<{
        coordinate_id: string
        direction: RouteDirection
        sort_order: number
      }>).map((r) => ({ coordinateId: r.coordinate_id, direction: r.direction }))
      set({ route, routeHasChanges: false })
    } catch (err) {
      console.error('経路の取得に失敗:', err)
    }
  },

  appendRoutePoint: (coordinateId, direction = 'down') => {
    set((state) => ({
      route: [...state.route, { coordinateId, direction }],
      routeHasChanges: true,
    }))
  },

  removeRoutePoint: (index) => {
    set((state) => ({
      route: state.route.filter((_, i) => i !== index),
      routeHasChanges: true,
    }))
  },

  setRouteDirection: (index, direction) => {
    set((state) => ({
      route: state.route.map((r, i) => (i === index ? { ...r, direction } : r)),
      routeHasChanges: true,
    }))
  },

  moveRoutePoint: (index, offset) => {
    set((state) => {
      const next = [...state.route]
      const target = index + offset
      if (index < 0 || index >= next.length || target < 0 || target >= next.length) {
        return state
      }
      const tmp = next[index]
      next[index] = next[target]
      next[target] = tmp
      return { route: next, routeHasChanges: true }
    })
  },

  clearRoute: () => {
    set({ route: [], routeHasChanges: true })
  },

  saveRoute: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return
    const { route } = get()
    try {
      // 既存の経路を削除
      const { error: delErr } = await supabase
        .from('design_coordinate_routes')
        .delete()
        .eq('farm_id', farmId)
      if (delErr) throw delErr

      if (route.length > 0) {
        const rows = route.map((r, idx) => ({
          farm_id: farmId,
          coordinate_id: r.coordinateId,
          direction: r.direction,
          sort_order: idx,
        }))
        const { error: insErr } = await supabase
          .from('design_coordinate_routes')
          .insert(rows as never)
        if (insErr) throw insErr
      }
      set({ routeHasChanges: false })
    } catch (err) {
      console.error('経路の保存に失敗:', err)
      throw err
    }
  },
}))
