import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { CoordinateType, DesignCoordinate, StakeStatus } from '@/types/database'
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
  /** 杭種（自由文字列。stakeTypes.ts のプリセットを推奨） */
  stakeType: string | null
  /** 設置状態（地籍測量モードの杭設置ワークフロー）。既定 'none' */
  stakeStatus: StakeStatus
  /** 作成日時 (ISO) */
  createdAt: string | null
  /** 最終更新日時 (ISO) */
  updatedAt: string | null
  /** 作成者 user_id */
  createdBy: string | null
  /** 最終更新者 user_id */
  updatedBy: string | null
}

/** importCoordinates の入力。点番号/X/Y は必須、それ以外は任意。 */
export interface ImportCoordinateInput {
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: CoordinateType
  stakeType?: string | null
  /** 備考。スマホ計測由来か等の出所を入れる用途に使う（例: 'mobile_measurement'） */
  notes?: string | null
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
  /** 大量データ取得時に done/total を出すための進捗。loading=false に戻ったときに null。 */
  loadingProgress: { done: number; total: number } | null
  error: string | null
  /**
   * 直近で fetchCoordinates を完了させた farm の id。
   * 同じ farm で再度 fetchCoordinates が呼ばれてもキャッシュを使い、サーバへ問い合わせない。
   * 編集系アクション (add/update/delete/import) はローカル state に反映するので、
   * キャッシュを通しても整合性は保てる。明示的に再取得したいときは invalidateCache() を使う。
   */
  loadedFarmId: string | null
  invalidateCache: () => void
  fetchCoordinates: (farmId: string) => Promise<void>
  addCoordinate: (type: CoordinateType) => Promise<void>
  updateCoordinate: (id: string, field: keyof CoordinateRow, value: string | number | null) => void
  deleteCoordinate: (id: string) => Promise<void>
  deleteCoordinates: (ids: string[]) => Promise<void>
  importCoordinates: (
    coords: ImportCoordinateInput[],
    onProgress?: (done: number, total: number) => void,
    options?: { skipStateUpdate?: boolean },
  ) => Promise<CoordinateRow[]>
  clearCoordinates: () => Promise<void>
  getCoordinateById: (id: string) => CoordinateRow | undefined
  /** 設置状態を即時 DB に反映（楽観 + サーバ更新。pendingChanges は通さない） */
  setStakeStatus: (id: string, status: StakeStatus) => Promise<void>

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

// 工区IDを取得するヘルパー
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
  loadingProgress: null,
  loadedFarmId: null,
  invalidateCache: () => set({ loadedFarmId: null }),
  error: null,

  fetchCoordinates: async (farmId: string) => {
    // 同じ farm でロード済みならキャッシュを使う（明示的な invalidateCache を経由するまで再取得しない）
    if (get().loadedFarmId === farmId) return
    // 工区切替時に旧データを即時クリアしておく（地図初期化が古い座標で走るのを防ぐ）
    set({ loading: true, error: null, coordinates: [], loadingProgress: null, loadedFarmId: null })
    try {
      // 総件数を先に取って、ページング中に done/total を伝えられるようにする
      let totalCount = 0
      {
        const { count } = await supabase
          .from('design_coordinates')
          .select('id', { count: 'exact', head: true })
          .eq('farm_id', farmId)
        totalCount = count ?? 0
      }
      if (totalCount > 0) {
        set({ loadingProgress: { done: 0, total: totalCount } })
      }

      // Supabase は既定で 1 リクエスト 1000 行までなので range() でページング取得
      const PAGE = 1000
      const all: DesignCoordinate[] = []
      let from = 0
      // 安全弁: 最大 100 万行で打ち切り
      while (from < 1_000_000) {
        const { data, error } = await supabase
          .from('design_coordinates')
          .select('*')
          .eq('farm_id', farmId)
          .order('point_number')
          .range(from, from + PAGE - 1)
        if (error) throw error
        const rows = (data || []) as DesignCoordinate[]
        all.push(...rows)
        if (totalCount > 0) {
          set({ loadingProgress: { done: all.length, total: totalCount } })
        }
        if (rows.length < PAGE) break
        from += PAGE
      }

      const zone = get().zone
      const converter = new CoordinateConverter(zone)

      const coordinates: CoordinateRow[] = all.map((row) => {
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
          stakeType: row.stake_type ?? null,
          stakeStatus: (row.stake_status ?? 'none') as StakeStatus,
          createdAt: row.created_at ?? null,
          updatedAt: row.updated_at ?? null,
          createdBy: row.created_by ?? null,
          updatedBy: row.updated_by ?? null,
        }
      })

      set({ coordinates, loading: false, loadingProgress: null, loadedFarmId: farmId })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '座標の取得に失敗しました',
        loading: false,
        loadingProgress: null,
        loadedFarmId: null,
      })
    }
  },

  addCoordinate: async (type) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return
    }

    const state = get()
    const pointNumber = `P${state.coordinates.length + 1}`

    try {
      const { data: { user } } = await supabase.auth.getUser()
      const uid = user?.id ?? null
      const { data, error } = await supabase
        .from('design_coordinates')
        .insert({
          farm_id: farmId,
          point_number: pointNumber,
          x: 0,
          y: 0,
          z: null,
          coordinate_type: type,
          stake_type: null,
          latitude: null,
          longitude: null,
          created_by: uid,
          updated_by: uid,
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
        stakeType: row.stake_type ?? null,
        stakeStatus: (row.stake_status ?? 'none') as StakeStatus,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        createdBy: row.created_by ?? null,
        updatedBy: row.updated_by ?? null,
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

    // 手動保存モードに統一: 変更を pendingChanges に積み、保存ボタンを有効化
    const newPendingChanges = new Map(state.pendingChanges)
    newPendingChanges.set(id, updated)
    set({ pendingChanges: newPendingChanges })
    useSettingsStore.getState().setHasUnsavedChanges(true)
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

  // 設置状態を即時 DB に反映。スマホ起工測量の現場操作からも呼ばれる想定なので、
  // pendingChanges (手動保存ボタン待ち) は通さず楽観 + サーバ更新の即時反映にする。
  setStakeStatus: async (id, status) => {
    const prev = get().coordinates.find((c) => c.id === id)
    if (!prev) return
    // 楽観反映
    set((state) => ({
      coordinates: state.coordinates.map((c) =>
        c.id === id ? { ...c, stakeStatus: status } : c,
      ),
    }))
    try {
      const { error } = await supabase
        .from('design_coordinates')
        .update({ stake_status: status } as never)
        .eq('id', id)
      if (error) throw error
    } catch (err) {
      // ロールバック
      set((state) => ({
        coordinates: state.coordinates.map((c) =>
          c.id === id ? { ...c, stakeStatus: prev.stakeStatus } : c,
        ),
        error: err instanceof Error ? err.message : '設置状態の保存に失敗しました',
      }))
    }
  },

  // 複数 ID を一括削除（in() は URL 長制限があるため 100 件ずつチャンク）
  deleteCoordinates: async (ids) => {
    if (ids.length === 0) return
    try {
      const CHUNK = 100
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK)
        const { error } = await supabase
          .from('design_coordinates')
          .delete()
          .in('id', slice)
        if (error) throw error
      }
      const idSet = new Set(ids)
      set((state) => ({
        coordinates: state.coordinates.filter((c) => !idSet.has(c.id)),
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標の一括削除に失敗しました' })
    }
  },

  importCoordinates: async (coords, onProgress, options) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return []
    }

    const state = get()
    const converter = new CoordinateConverter(state.zone)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      const uid = user?.id ?? null
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
          stake_type: c.stakeType ?? null,
          latitude: lat,
          longitude: lng,
          notes: c.notes ?? null,
          created_by: uid,
          updated_by: uid,
        }
      })

      // 大量データ対応: 200 件ずつチャンクして INSERT し、進捗を通知。
      // - 以前は CHUNK=500 + select() で全カラム取得していたが、大規模 SIM
      //   （1 万点以上）で最後のチャンクが応答せず固まるケースが頻発した
      //   ため、チャンクを小さくし、戻りも id / point_number のみに絞る
      // - 状態に積む CoordinateRow は入力 + 返却 id を組み合わせて構築する
      const CHUNK = 200
      const allNew: CoordinateRow[] = []
      const total = insertData.length
      onProgress?.(0, total)
      for (let i = 0; i < total; i += CHUNK) {
        const slice = insertData.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from('design_coordinates')
          .insert(slice as never)
          .select('id, point_number')
        if (error) throw error
        const idByPn = new Map<string, string>()
        for (const row of (data || []) as Array<{ id: string; point_number: string }>) {
          idByPn.set(row.point_number, row.id)
        }
        for (const src of slice) {
          const id = idByPn.get(src.point_number)
          if (!id) continue
          allNew.push({
            id,
            pointNumber: src.point_number,
            x: src.x,
            y: src.y,
            z: src.z,
            lat: src.latitude,
            lng: src.longitude,
            type: src.coordinate_type as CoordinateType,
            stakeType: src.stake_type ?? null,
            stakeStatus: 'none',
            createdAt: null,
            updatedAt: null,
            createdBy: src.created_by,
            updatedBy: src.updated_by,
          })
        }
        onProgress?.(Math.min(i + CHUNK, total), total)
        // UI が描画する機会を入れる（連続 await でも yield されるとは限らないので明示的に）
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      // skipStateUpdate=true のときはここでストアを更新しない
      // （巨大インポートで全 marker を一気にレンダーすると JS スレッドが詰まるので、
      //  呼び出し元が最後に fetchCoordinates で取り直す運用にする）
      if (!options?.skipStateUpdate) {
        set({ coordinates: [...state.coordinates, ...allNew] })
      }
      return allNew
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '座標のインポートに失敗しました' })
      return []
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
      // 現在のログインユーザー（DB トリガでも自動設定されるが、念のためクライアントからも送る）
      const { data: { user } } = await supabase.auth.getUser()
      const uid = user?.id ?? null

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
            stake_type: coord.stakeType,
            stake_status: coord.stakeStatus,
            latitude: coord.lat,
            longitude: coord.lng,
            updated_by: uid,
            updated_at: new Date().toISOString(),
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
