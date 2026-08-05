import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// 出力点（PipeCoordinateCalcPage の ExportPoint と同形）
export interface RoutePoint {
  id: string
  name: string
  x: number
  y: number
  z: number | null
  source: 'pipe' | 'coordinate'
  type?: string
}

// 1 farm に対して複数のルートを持てる (name で区別)。
export interface Route {
  id: string
  name: string
  points: RoutePoint[]
}

// 現在アクティブなルートを farm ごとに localStorage で覚える key
const ACTIVE_ROUTE_STORAGE_KEY = 'nodecloud:mobility:activeRouteByFarm'

function loadActiveMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(ACTIVE_ROUTE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

function saveActiveMap(map: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ACTIVE_ROUTE_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* noop */
  }
}

interface ExportRouteState {
  /** farmId → Route[] (name 昇順) */
  routesByFarmId: Map<string, Route[]>
  /** farmId → 現在アクティブな route id (mobile が使う) */
  activeRouteIdByFarmId: Record<string, string>
  loading: boolean
  saving: boolean
  error: string | null

  fetchRoutes: (farmId: string) => Promise<Route[]>
  getRoutes: (farmId: string) => Route[]
  /** 現在アクティブに選ばれているルート (name/points)。未選択 or ない場合は先頭 or null */
  getActiveRoute: (farmId: string) => Route | null
  setActiveRoute: (farmId: string, routeId: string | null) => void
  /**
   * 保存: id を指定すれば UPDATE、なければ INSERT (name 重複時は既存を上書き)。
   * 戻り値: 保存された Route (or 失敗時 null)
   */
  saveRoute: (
    farmId: string,
    name: string,
    points: RoutePoint[],
    id?: string,
  ) => Promise<Route | null>
  deleteRoute: (farmId: string, routeId: string) => Promise<boolean>

  // 後方互換用 (旧 API): 既定名 '既定' で保存。
  saveDefaultRoute: (farmId: string, points: RoutePoint[]) => Promise<boolean>
  /** 後方互換用 (旧 API): 既定 route の points を返す (無ければ空) */
  fetchRoute: (farmId: string) => Promise<RoutePoint[] | null>
}

interface RouteRow {
  id: string
  farm_id: string
  name: string | null
  points: RoutePoint[] | null
}

function toRoute(row: RouteRow): Route {
  return {
    id: row.id,
    name: row.name ?? '既定',
    points: (row.points ?? []) as RoutePoint[],
  }
}

export const useExportRouteStore = create<ExportRouteState>((set, get) => ({
  routesByFarmId: new Map(),
  activeRouteIdByFarmId: loadActiveMap(),
  loading: false,
  saving: false,
  error: null,

  getRoutes: (farmId) => get().routesByFarmId.get(farmId) ?? [],

  getActiveRoute: (farmId) => {
    const routes = get().routesByFarmId.get(farmId) ?? []
    if (routes.length === 0) return null
    const activeId = get().activeRouteIdByFarmId[farmId]
    if (activeId) {
      const hit = routes.find((r) => r.id === activeId)
      if (hit) return hit
    }
    return routes[0]
  },

  setActiveRoute: (farmId, routeId) => {
    const next = { ...get().activeRouteIdByFarmId }
    if (routeId) next[farmId] = routeId
    else delete next[farmId]
    saveActiveMap(next)
    set({ activeRouteIdByFarmId: next })
  },

  fetchRoutes: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('export_point_routes')
        .select('id, farm_id, name, points')
        .eq('farm_id', farmId)
        .order('name', { ascending: true })
      if (error) throw error
      const routes = ((data ?? []) as RouteRow[]).map(toRoute)
      const next = new Map(get().routesByFarmId)
      next.set(farmId, routes)
      set({ routesByFarmId: next, loading: false })
      return routes
    } catch (err) {
      console.error('[exportRouteStore] fetchRoutes failed', err)
      set({
        loading: false,
        error: err instanceof Error ? err.message : '順路の読み込みに失敗しました',
      })
      return []
    }
  },

  saveRoute: async (farmId, name, points, id) => {
    set({ saving: true, error: null })
    try {
      const trimmedName = name.trim() || '既定'
      let saved: Route | null = null
      if (id) {
        // UPDATE
        const { data, error } = await supabase
          .from('export_point_routes')
          .update({ name: trimmedName, points } as never)
          .eq('id', id)
          .select('id, farm_id, name, points')
          .maybeSingle()
        if (error) throw error
        if (data) saved = toRoute(data as RouteRow)
      } else {
        // UPSERT (name 重複時は上書き)
        const { data, error } = await supabase
          .from('export_point_routes')
          .upsert(
            { farm_id: farmId, name: trimmedName, points } as never,
            { onConflict: 'farm_id,name' },
          )
          .select('id, farm_id, name, points')
          .maybeSingle()
        if (error) throw error
        if (data) saved = toRoute(data as RouteRow)
      }
      if (!saved) throw new Error('保存結果を取得できませんでした')

      // ローカルキャッシュ更新
      const next = new Map(get().routesByFarmId)
      const cur = (next.get(farmId) ?? []).filter((r) => r.id !== saved!.id)
      cur.push(saved)
      cur.sort((a, b) => a.name.localeCompare(b.name))
      next.set(farmId, cur)
      set({ routesByFarmId: next, saving: false })
      return saved
    } catch (err) {
      console.error('[exportRouteStore] saveRoute failed', err)
      set({
        saving: false,
        error: err instanceof Error ? err.message : '順路の保存に失敗しました',
      })
      return null
    }
  },

  deleteRoute: async (farmId, routeId) => {
    try {
      const { error } = await supabase
        .from('export_point_routes')
        .delete()
        .eq('id', routeId)
      if (error) throw error
      const next = new Map(get().routesByFarmId)
      const cur = (next.get(farmId) ?? []).filter((r) => r.id !== routeId)
      next.set(farmId, cur)
      // active が消えたら解除
      const activeMap = { ...get().activeRouteIdByFarmId }
      if (activeMap[farmId] === routeId) {
        delete activeMap[farmId]
        saveActiveMap(activeMap)
      }
      set({ routesByFarmId: next, activeRouteIdByFarmId: activeMap })
      return true
    } catch (err) {
      console.error('[exportRouteStore] deleteRoute failed', err)
      return false
    }
  },

  // ============================================================
  // 後方互換: 単一ルート API
  // ============================================================
  saveDefaultRoute: async (farmId, points) => {
    const saved = await get().saveRoute(farmId, '既定', points)
    return saved != null
  },

  fetchRoute: async (farmId) => {
    const routes = await get().fetchRoutes(farmId)
    const active = get().getActiveRoute(farmId)
    if (active) return active.points
    return routes[0]?.points ?? []
  },
}))
