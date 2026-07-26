// 地図上のペイントストローク (map_drawings) を工区単位でキャッシュ + CRUD するストア。
//
// 用途:
//   ・スマホ (MobileStakingPage) / PC (全体図) の描画モードで使う
//   ・pan/zoom で位置が変わらないよう lat/lng で保存

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type LineStyle = 'solid' | 'dashed' | 'dotted'

export interface MapDrawingStroke {
  id: string
  farm_id: string
  created_by: string | null
  color: string
  width_px: number
  line_style: LineStyle
  /** ストロークを構成する頂点 (lat/lng) */
  points: Array<{ lat: number; lng: number }>
  created_at: string
  updated_at: string
}

interface State {
  byFarm: Map<string, MapDrawingStroke[]>
  loadingFarms: Set<string>
  error: string | null

  fetchByFarm: (farmId: string) => Promise<void>
  addStroke: (input: {
    farmId: string
    color: string
    widthPx: number
    lineStyle: LineStyle
    points: Array<{ lat: number; lng: number }>
  }) => Promise<MapDrawingStroke | null>
  deleteStroke: (id: string) => Promise<void>
  clearFarm: (farmId: string) => Promise<void>
  invalidate: (farmId?: string) => void
}

export const useMapDrawingStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loadingFarms: new Set(),
  error: null,

  fetchByFarm: async (farmId) => {
    if (!farmId) return
    const loading = new Set(get().loadingFarms)
    if (loading.has(farmId)) return
    loading.add(farmId)
    set({ loadingFarms: loading })
    try {
      const { data, error } = await supabase
        .from('map_drawings')
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at', { ascending: true })
      if (error) throw error
      const map = new Map(get().byFarm)
      map.set(farmId, (data ?? []) as MapDrawingStroke[])
      set({ byFarm: map, error: null })
    } catch (err) {
      console.error('[mapDrawingStore] fetch failed', err, { farmId })
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      const next = new Set(get().loadingFarms)
      next.delete(farmId)
      set({ loadingFarms: next })
    }
  },

  addStroke: async ({ farmId, color, widthPx, lineStyle, points }) => {
    if (points.length < 2) return null
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id ?? null
      const { data, error } = await supabase
        .from('map_drawings')
        .insert({
          farm_id: farmId,
          created_by: uid,
          color,
          width_px: widthPx,
          line_style: lineStyle,
          points,
        } as never)
        .select()
        .single()
      if (error) throw error
      const stroke = data as MapDrawingStroke
      const map = new Map(get().byFarm)
      const list = [...(map.get(farmId) ?? []), stroke]
      map.set(farmId, list)
      set({ byFarm: map })
      return stroke
    } catch (err) {
      console.error('[mapDrawingStore] add failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  deleteStroke: async (id) => {
    // 楽観削除: まず自ストアから消し、失敗したら戻す
    let removed: { farmId: string; stroke: MapDrawingStroke } | null = null
    const map = new Map(get().byFarm)
    for (const [fid, list] of map.entries()) {
      const idx = list.findIndex((s) => s.id === id)
      if (idx >= 0) {
        removed = { farmId: fid, stroke: list[idx] }
        const next = [...list]
        next.splice(idx, 1)
        map.set(fid, next)
        set({ byFarm: map })
        break
      }
    }
    try {
      const { error } = await supabase.from('map_drawings').delete().eq('id', id)
      if (error) throw error
    } catch (err) {
      // ロールバック
      if (removed) {
        const cur = new Map(get().byFarm)
        cur.set(removed.farmId, [...(cur.get(removed.farmId) ?? []), removed.stroke])
        set({ byFarm: cur })
      }
      console.error('[mapDrawingStore] delete failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  clearFarm: async (farmId) => {
    try {
      const { error } = await supabase
        .from('map_drawings')
        .delete()
        .eq('farm_id', farmId)
      if (error) throw error
      const map = new Map(get().byFarm)
      map.set(farmId, [])
      set({ byFarm: map })
    } catch (err) {
      console.error('[mapDrawingStore] clear failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  invalidate: (farmId) => {
    if (!farmId) {
      set({ byFarm: new Map() })
      return
    }
    const map = new Map(get().byFarm)
    map.delete(farmId)
    set({ byFarm: map })
  },
}))

/** zustand セレクタで stable 空参照 (React error #185 対策) */
export const EMPTY_STROKES: ReadonlyArray<MapDrawingStroke> = Object.freeze([])
