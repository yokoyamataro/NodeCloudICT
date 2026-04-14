import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { CoordinateType, AreaCalculationSheet, DesignCoordinate, DesignZone } from '@/types/database'
import { CoordinateConverter } from '@/lib/coordinates'
import { generateAreaCalculationSheet, type Point } from '@/lib/area-calculation'
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

// ローカル状態用の区域型
export interface ZoneRow {
  id: string
  zoneNumber: string
  name: string
  pointIds: string[]     // 構成点IDリスト
  areaSqm: number | null
  areaHa: number | null
  perimeterM: number | null
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

  // 区域データ
  zones: ZoneRow[]
  fetchZones: (farmId: string) => Promise<void>
  addZone: () => Promise<void>
  updateZone: (id: string, field: keyof ZoneRow, value: string | string[] | number | null) => void
  deleteZone: (id: string) => Promise<void>
  addPointToZone: (zoneId: string, pointId: string) => void
  removePointFromZone: (zoneId: string, pointId: string) => void
  reorderZonePoints: (zoneId: string, pointIds: string[]) => void
  calculateZoneArea: (zoneId: string) => AreaCalculationSheet | null

  // フィルタリング
  selectedType: CoordinateType
  setSelectedType: (type: CoordinateType) => void
  getFilteredCoordinates: () => CoordinateRow[]

  // 手動保存モード用
  pendingChanges: Map<string, CoordinateRow>
  pendingZoneChanges: Map<string, ZoneRow>
  saveAllCoordinates: () => Promise<void>
  resetCoordinateChanges: () => void
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

      set((state) => {
        // 座標を削除
        const newCoordinates = state.coordinates.filter((c) => c.id !== id)
        // 区域から参照を削除
        const newZones = state.zones.map((zone) => ({
          ...zone,
          pointIds: zone.pointIds.filter((pid) => pid !== id),
        }))
        return { coordinates: newCoordinates, zones: newZones }
      })
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

      // 区域も全削除
      const { error: zoneError } = await supabase
        .from('design_zones')
        .delete()
        .eq('farm_id', farmId)

      if (zoneError) throw zoneError

      set({ coordinates: [], zones: [] })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'データの削除に失敗しました' })
    }
  },

  getCoordinateById: (id) => {
    return get().coordinates.find((c) => c.id === id)
  },

  // 区域データ
  zones: [],

  fetchZones: async (farmId: string) => {
    try {
      const { data, error } = await supabase
        .from('design_zones')
        .select('*')
        .eq('farm_id', farmId)
        .order('zone_number')

      if (error) throw error

      const zones: ZoneRow[] = ((data || []) as DesignZone[]).map((row) => ({
        id: row.id,
        zoneNumber: row.zone_number,
        name: row.name,
        pointIds: row.point_ids || [],
        areaSqm: row.area_sqm,
        areaHa: row.area_ha,
        perimeterM: row.perimeter_m,
      }))

      set({ zones })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '区域の取得に失敗しました' })
    }
  },

  addZone: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '圃場が選択されていません' })
      return
    }

    const state = get()
    const zoneNumber = `Z${state.zones.length + 1}`
    const name = `区域${state.zones.length + 1}`

    try {
      const { data, error } = await supabase
        .from('design_zones')
        .insert({
          farm_id: farmId,
          zone_number: zoneNumber,
          name,
          point_ids: [],
          area_sqm: null,
          area_ha: null,
          perimeter_m: null,
        } as never)
        .select()
        .single()

      if (error) throw error

      const row = data as DesignZone
      const newZone: ZoneRow = {
        id: row.id,
        zoneNumber: row.zone_number,
        name: row.name,
        pointIds: row.point_ids || [],
        areaSqm: row.area_sqm,
        areaHa: row.area_ha,
        perimeterM: row.perimeter_m,
      }

      set({ zones: [...state.zones, newZone] })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '区域の追加に失敗しました' })
    }
  },

  updateZone: (id, field, value) => {
    const state = get()
    const zone = state.zones.find((z) => z.id === id)
    if (!zone) return

    const updated = { ...zone, [field]: value }

    // ローカル状態を即座に更新
    set({
      zones: state.zones.map((z) => (z.id === id ? updated : z)),
    })

    // 保存モードをチェック
    const saveMode = useSettingsStore.getState().saveMode
    if (saveMode === 'manual') {
      // 手動保存モード: 変更を記録
      const newPendingZoneChanges = new Map(state.pendingZoneChanges)
      newPendingZoneChanges.set(id, updated as ZoneRow)
      set({ pendingZoneChanges: newPendingZoneChanges })
      useSettingsStore.getState().setHasUnsavedChanges(true)
    } else {
      // 自動保存モード: 即座にSupabaseに保存
      const dbFieldMap: Record<string, string> = {
        zoneNumber: 'zone_number',
        pointIds: 'point_ids',
        areaSqm: 'area_sqm',
        areaHa: 'area_ha',
        perimeterM: 'perimeter_m',
      }
      const dbField = dbFieldMap[field] || field

      supabase
        .from('design_zones')
        .update({ [dbField]: value } as never)
        .eq('id', id)
        .then(({ error }) => {
          if (error) {
            set({ error: error.message })
          }
        })
    }
  },

  deleteZone: async (id) => {
    try {
      const { error } = await supabase
        .from('design_zones')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        zones: state.zones.filter((z) => z.id !== id),
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '区域の削除に失敗しました' })
    }
  },

  addPointToZone: (zoneId, pointId) => {
    const state = get()
    const zone = state.zones.find((z) => z.id === zoneId)
    if (!zone || zone.pointIds.includes(pointId)) return

    const newPointIds = [...zone.pointIds, pointId]
    get().updateZone(zoneId, 'pointIds', newPointIds)
  },

  removePointFromZone: (zoneId, pointId) => {
    const state = get()
    const zone = state.zones.find((z) => z.id === zoneId)
    if (!zone) return

    const newPointIds = zone.pointIds.filter((id) => id !== pointId)
    get().updateZone(zoneId, 'pointIds', newPointIds)
  },

  reorderZonePoints: (zoneId, pointIds) => {
    get().updateZone(zoneId, 'pointIds', pointIds)
  },

  calculateZoneArea: (zoneId) => {
    const state = get()
    const zone = state.zones.find((z) => z.id === zoneId)
    if (!zone || zone.pointIds.length < 3) return null

    // 構成点を取得
    const points: Point[] = zone.pointIds
      .map((id) => state.coordinates.find((c) => c.id === id))
      .filter((c): c is CoordinateRow => c !== undefined)
      .map((c) => ({
        id: c.id,
        pointNumber: c.pointNumber,
        x: c.x,
        y: c.y,
      }))

    if (points.length < 3) return null

    // 面積計算簿を生成
    const sheet = generateAreaCalculationSheet(
      zone.id,
      zone.zoneNumber,
      zone.name,
      points
    )

    // 区域の面積情報を更新（非同期だがawaitしない）
    get().updateZone(zoneId, 'areaSqm', sheet.area_sqm)
    get().updateZone(zoneId, 'areaHa', sheet.area_ha)
    get().updateZone(zoneId, 'perimeterM', sheet.perimeter_m)

    return sheet
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
  pendingZoneChanges: new Map(),

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

      // 区域の変更を保存
      for (const [id, zone] of state.pendingZoneChanges) {
        const { error } = await supabase
          .from('design_zones')
          .update({
            zone_number: zone.zoneNumber,
            name: zone.name,
            point_ids: zone.pointIds,
            area_sqm: zone.areaSqm,
            area_ha: zone.areaHa,
            perimeter_m: zone.perimeterM,
          } as never)
          .eq('id', id)

        if (error) throw error
      }

      // 変更をクリア
      set({ pendingChanges: new Map(), pendingZoneChanges: new Map() })
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
    get().fetchZones(farmId)

    // 変更をクリア
    set({ pendingChanges: new Map(), pendingZoneChanges: new Map() })
    useSettingsStore.getState().setHasUnsavedChanges(false)
  },
}))
