import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CoordinateType, AreaCalculationSheet } from '@/types/database'
import { CoordinateConverter } from '@/lib/coordinates'
import { generateAreaCalculationSheet, type Point } from '@/lib/area-calculation'

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
  addCoordinate: (type: CoordinateType) => void
  updateCoordinate: (id: string, field: keyof CoordinateRow, value: string | number | null) => void
  deleteCoordinate: (id: string) => void
  importCoordinates: (coords: Omit<CoordinateRow, 'id' | 'lat' | 'lng'>[]) => void
  clearCoordinates: () => void
  getCoordinateById: (id: string) => CoordinateRow | undefined

  // 区域データ
  zones: ZoneRow[]
  addZone: () => void
  updateZone: (id: string, field: keyof ZoneRow, value: string | string[] | number | null) => void
  deleteZone: (id: string) => void
  addPointToZone: (zoneId: string, pointId: string) => void
  removePointFromZone: (zoneId: string, pointId: string) => void
  reorderZonePoints: (zoneId: string, pointIds: string[]) => void
  calculateZoneArea: (zoneId: string) => AreaCalculationSheet | null

  // フィルタリング
  selectedType: CoordinateType
  setSelectedType: (type: CoordinateType) => void
  getFilteredCoordinates: () => CoordinateRow[]
}

export const useCoordinateStore = create<CoordinateState>()(
  persist(
    (set, get) => ({
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

      addCoordinate: (type) => {
        const state = get()
        const newCoord: CoordinateRow = {
          id: crypto.randomUUID(),
          pointNumber: `P${state.coordinates.length + 1}`,
          x: 0,
          y: 0,
          z: null,
          lat: null,
          lng: null,
          type,
        }
        set({ coordinates: [...state.coordinates, newCoord] })
      },

      updateCoordinate: (id, field, value) => {
        const state = get()
        const converter = new CoordinateConverter(state.zone)

        set({
          coordinates: state.coordinates.map((coord) => {
            if (coord.id !== id) return coord

            const updated = { ...coord, [field]: value }

            // X, Y が更新されたら緯度経度を再計算
            if (field === 'x' || field === 'y') {
              if (updated.x && updated.y) {
                const { lat, lng } = converter.toLatLng(updated.x, updated.y)
                updated.lat = lat
                updated.lng = lng
              }
            }

            return updated
          }),
        })
      },

      deleteCoordinate: (id) => {
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
      },

      importCoordinates: (coords) => {
        const state = get()
        const converter = new CoordinateConverter(state.zone)

        const newCoords: CoordinateRow[] = coords.map((c) => {
          let lat: number | null = null
          let lng: number | null = null
          if (c.x && c.y) {
            const result = converter.toLatLng(c.x, c.y)
            lat = result.lat
            lng = result.lng
          }
          return {
            id: crypto.randomUUID(),
            ...c,
            lat,
            lng,
          }
        })

        set({ coordinates: [...state.coordinates, ...newCoords] })
      },

      clearCoordinates: () => set({ coordinates: [], zones: [] }),

      getCoordinateById: (id) => {
        return get().coordinates.find((c) => c.id === id)
      },

      // 区域データ
      zones: [],

      addZone: () => {
        const state = get()
        const newZone: ZoneRow = {
          id: crypto.randomUUID(),
          zoneNumber: `Z${state.zones.length + 1}`,
          name: `区域${state.zones.length + 1}`,
          pointIds: [],
          areaSqm: null,
          areaHa: null,
          perimeterM: null,
        }
        set({ zones: [...state.zones, newZone] })
      },

      updateZone: (id, field, value) => {
        set((state) => ({
          zones: state.zones.map((zone) =>
            zone.id === id ? { ...zone, [field]: value } : zone
          ),
        }))
      },

      deleteZone: (id) => {
        set((state) => ({
          zones: state.zones.filter((z) => z.id !== id),
        }))
      },

      addPointToZone: (zoneId, pointId) => {
        set((state) => ({
          zones: state.zones.map((zone) => {
            if (zone.id !== zoneId) return zone
            if (zone.pointIds.includes(pointId)) return zone
            return { ...zone, pointIds: [...zone.pointIds, pointId] }
          }),
        }))
      },

      removePointFromZone: (zoneId, pointId) => {
        set((state) => ({
          zones: state.zones.map((zone) =>
            zone.id === zoneId
              ? { ...zone, pointIds: zone.pointIds.filter((id) => id !== pointId) }
              : zone
          ),
        }))
      },

      reorderZonePoints: (zoneId, pointIds) => {
        set((state) => ({
          zones: state.zones.map((zone) =>
            zone.id === zoneId ? { ...zone, pointIds } : zone
          ),
        }))
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

        // 区域の面積情報を更新
        set((state) => ({
          zones: state.zones.map((z) =>
            z.id === zoneId
              ? {
                  ...z,
                  areaSqm: sheet.area_sqm,
                  areaHa: sheet.area_ha,
                  perimeterM: sheet.perimeter_m,
                }
              : z
          ),
        }))

        return sheet
      },

      // フィルタリング
      selectedType: 'control',
      setSelectedType: (type) => set({ selectedType: type }),

      getFilteredCoordinates: () => {
        const state = get()
        return state.coordinates.filter((c) => c.type === state.selectedType)
      },
    }),
    {
      name: 'coordinate-storage',
      partialize: (state) => ({
        zone: state.zone,
        coordinates: state.coordinates,
        zones: state.zones,
        selectedType: state.selectedType,
      }),
    }
  )
)
