import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// 出力点（PipeCoordinateCalcPage の ExportPoint と同形）
// 重複定義を避けるため最小限のフィールドのみ。type は座標管理点用の任意値。
export interface RoutePoint {
  id: string
  name: string
  x: number
  y: number
  z: number | null
  source: 'pipe' | 'coordinate'
  type?: string
}

interface ExportRouteState {
  // farmId → 順路（保存済み）
  routesByFarmId: Map<string, RoutePoint[]>
  loading: boolean
  saving: boolean
  error: string | null

  fetchRoute: (farmId: string) => Promise<RoutePoint[] | null>
  saveRoute: (farmId: string, points: RoutePoint[]) => Promise<boolean>
  getRoute: (farmId: string) => RoutePoint[] | null
}

export const useExportRouteStore = create<ExportRouteState>((set, get) => ({
  routesByFarmId: new Map(),
  loading: false,
  saving: false,
  error: null,

  getRoute: (farmId) => {
    return get().routesByFarmId.get(farmId) ?? null
  },

  fetchRoute: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('export_point_routes')
        .select('points')
        .eq('farm_id', farmId)
        .maybeSingle()
      if (error) throw error
      const points = ((data as { points?: RoutePoint[] } | null)?.points ?? []) as RoutePoint[]
      const next = new Map(get().routesByFarmId)
      next.set(farmId, points)
      set({ routesByFarmId: next, loading: false })
      return points
    } catch (err) {
      console.error('[exportRouteStore] fetchRoute failed', err)
      set({
        loading: false,
        error: err instanceof Error ? err.message : '順路の読み込みに失敗しました',
      })
      return null
    }
  },

  saveRoute: async (farmId, points) => {
    set({ saving: true, error: null })
    // 楽観更新
    const prev = get().routesByFarmId
    const optimistic = new Map(prev)
    optimistic.set(farmId, points)
    set({ routesByFarmId: optimistic })

    try {
      const { error } = await supabase
        .from('export_point_routes')
        .upsert(
          { farm_id: farmId, points } as never,
          { onConflict: 'farm_id' },
        )
      if (error) throw error
      set({ saving: false })
      return true
    } catch (err) {
      console.error('[exportRouteStore] saveRoute failed', err)
      set({
        routesByFarmId: prev,
        saving: false,
        error: err instanceof Error ? err.message : '順路の保存に失敗しました',
      })
      return false
    }
  },
}))
