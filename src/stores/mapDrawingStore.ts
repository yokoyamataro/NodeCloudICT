// 地図上のペイント (map_drawings) を工区単位でキャッシュ + CRUD するストア。
//
// 種別 (kind):
//   ・'stroke' 手書き線 (points: 頂点列)
//   ・'text'   テキスト注釈 (points: [ラベル位置 1 点] + text)
//
// undo/redo:
//   ・セッション内の add/delete 操作を undoStack に積む
//   ・undo: 操作を反転して DB + ストアに反映、redoStack に移動
//   ・新規操作が入ったら redoStack はクリア

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type DrawingKind = 'stroke' | 'text'

export interface MapDrawingStroke {
  id: string
  farm_id: string
  created_by: string | null
  kind: DrawingKind
  color: string
  width_px: number
  line_style: LineStyle
  /** stroke: 頂点列, text: [ラベル位置] の 1 点 */
  points: Array<{ lat: number; lng: number }>
  /** kind='text' のときのラベル文字列 */
  text: string | null
  created_at: string
  updated_at: string
}

/** undo/redo で扱う操作履歴 */
type HistoryOp =
  | { op: 'add'; farmId: string; item: MapDrawingStroke }
  | { op: 'delete'; farmId: string; item: MapDrawingStroke }

interface State {
  byFarm: Map<string, MapDrawingStroke[]>
  loadingFarms: Set<string>
  error: string | null
  undoStack: HistoryOp[]
  redoStack: HistoryOp[]

  fetchByFarm: (farmId: string) => Promise<void>
  addStroke: (input: {
    farmId: string
    color: string
    widthPx: number
    lineStyle: LineStyle
    points: Array<{ lat: number; lng: number }>
  }) => Promise<MapDrawingStroke | null>
  addText: (input: {
    farmId: string
    color: string
    widthPx: number
    lat: number
    lng: number
    text: string
  }) => Promise<MapDrawingStroke | null>
  deleteStroke: (id: string) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  invalidate: (farmId?: string) => void
}

// ------ 内部: 履歴を追跡しない DB 操作 (再実行時の重複履歴防止) ------
async function insertItemInternal(
  input: {
    farmId: string
    kind: DrawingKind
    color: string
    widthPx: number
    lineStyle: LineStyle
    points: Array<{ lat: number; lng: number }>
    text: string | null
  },
): Promise<MapDrawingStroke | null> {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData.user?.id ?? null
  const { data, error } = await supabase
    .from('map_drawings')
    .insert({
      farm_id: input.farmId,
      created_by: uid,
      kind: input.kind,
      color: input.color,
      width_px: input.widthPx,
      line_style: input.lineStyle,
      points: input.points,
      text: input.text,
    } as never)
    .select()
    .single()
  if (error) throw error
  return data as MapDrawingStroke
}

export const useMapDrawingStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loadingFarms: new Set(),
  error: null,
  undoStack: [],
  redoStack: [],

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
      // fetch 時は履歴もリセット (別セッションの変更を混ぜないため)
      set({ byFarm: map, error: null, undoStack: [], redoStack: [] })
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
    // 楽観追加: temp ID で先にストアに入れる
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: MapDrawingStroke = {
      id: tempId,
      farm_id: farmId,
      created_by: null,
      kind: 'stroke',
      color,
      width_px: widthPx,
      line_style: lineStyle,
      points,
      text: null,
      created_at: now,
      updated_at: now,
    }
    {
      const map = new Map(get().byFarm)
      const list = [...(map.get(farmId) ?? []), optimistic]
      map.set(farmId, list)
      set({ byFarm: map })
    }
    try {
      const stroke = await insertItemInternal({
        farmId,
        kind: 'stroke',
        color,
        widthPx,
        lineStyle,
        points,
        text: null,
      })
      if (!stroke) throw new Error('insert returned null')
      const map = new Map(get().byFarm)
      const list = (map.get(farmId) ?? []).map((s) => (s.id === tempId ? stroke : s))
      map.set(farmId, list)
      // 履歴に add を積み、redo をクリア
      set({
        byFarm: map,
        undoStack: [...get().undoStack, { op: 'add', farmId, item: stroke }],
        redoStack: [],
      })
      return stroke
    } catch (err) {
      console.error('[mapDrawingStore] add stroke failed', err)
      const map = new Map(get().byFarm)
      const list = (map.get(farmId) ?? []).filter((s) => s.id !== tempId)
      map.set(farmId, list)
      set({ byFarm: map, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  addText: async ({ farmId, color, widthPx, lat, lng, text }) => {
    if (!text || !text.trim()) return null
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: MapDrawingStroke = {
      id: tempId,
      farm_id: farmId,
      created_by: null,
      kind: 'text',
      color,
      width_px: widthPx,
      line_style: 'solid',
      points: [{ lat, lng }],
      text: text.trim(),
      created_at: now,
      updated_at: now,
    }
    {
      const map = new Map(get().byFarm)
      const list = [...(map.get(farmId) ?? []), optimistic]
      map.set(farmId, list)
      set({ byFarm: map })
    }
    try {
      const item = await insertItemInternal({
        farmId,
        kind: 'text',
        color,
        widthPx,
        lineStyle: 'solid',
        points: [{ lat, lng }],
        text: text.trim(),
      })
      if (!item) throw new Error('insert returned null')
      const map = new Map(get().byFarm)
      const list = (map.get(farmId) ?? []).map((s) => (s.id === tempId ? item : s))
      map.set(farmId, list)
      set({
        byFarm: map,
        undoStack: [...get().undoStack, { op: 'add', farmId, item }],
        redoStack: [],
      })
      return item
    } catch (err) {
      console.error('[mapDrawingStore] add text failed', err)
      const map = new Map(get().byFarm)
      const list = (map.get(farmId) ?? []).filter((s) => s.id !== tempId)
      map.set(farmId, list)
      set({ byFarm: map, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  deleteStroke: async (id) => {
    // 楽観削除
    let removed: { farmId: string; item: MapDrawingStroke } | null = null
    const map = new Map(get().byFarm)
    for (const [fid, list] of map.entries()) {
      const idx = list.findIndex((s) => s.id === id)
      if (idx >= 0) {
        removed = { farmId: fid, item: list[idx] }
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
      if (removed) {
        set({
          undoStack: [
            ...get().undoStack,
            { op: 'delete', farmId: removed.farmId, item: removed.item },
          ],
          redoStack: [],
        })
      }
    } catch (err) {
      // ロールバック
      if (removed) {
        const cur = new Map(get().byFarm)
        cur.set(removed.farmId, [...(cur.get(removed.farmId) ?? []), removed.item])
        set({ byFarm: cur })
      }
      console.error('[mapDrawingStore] delete failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  undo: async () => {
    const stack = get().undoStack
    if (stack.length === 0) return
    const last = stack[stack.length - 1]
    const rest = stack.slice(0, -1)
    // 履歴を先に更新 (再帰呼出しで addStroke/deleteStroke を使うと undoStack が
    // 汚染されるので、内部関数で DB 操作を行う)
    try {
      if (last.op === 'add') {
        // add を undo = delete
        const { error } = await supabase
          .from('map_drawings')
          .delete()
          .eq('id', last.item.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        const list = (map.get(last.farmId) ?? []).filter((s) => s.id !== last.item.id)
        map.set(last.farmId, list)
        set({
          byFarm: map,
          undoStack: rest,
          redoStack: [...get().redoStack, last],
        })
      } else {
        // delete を undo = 再 insert
        const item = await insertItemInternal({
          farmId: last.farmId,
          kind: last.item.kind,
          color: last.item.color,
          widthPx: last.item.width_px,
          lineStyle: last.item.line_style,
          points: last.item.points,
          text: last.item.text,
        })
        if (!item) throw new Error('re-insert returned null')
        const map = new Map(get().byFarm)
        const list = [...(map.get(last.farmId) ?? []), item]
        map.set(last.farmId, list)
        // redo する時は新しい item (ID が違う) を消す必要があるので、redoStack に
        // 新 item で登録
        set({
          byFarm: map,
          undoStack: rest,
          redoStack: [
            ...get().redoStack,
            { op: 'delete', farmId: last.farmId, item },
          ],
        })
      }
    } catch (err) {
      console.error('[mapDrawingStore] undo failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  redo: async () => {
    const stack = get().redoStack
    if (stack.length === 0) return
    const last = stack[stack.length - 1]
    const rest = stack.slice(0, -1)
    try {
      if (last.op === 'add') {
        // add を redo = 再 insert (undo で delete された後の再現)
        const item = await insertItemInternal({
          farmId: last.farmId,
          kind: last.item.kind,
          color: last.item.color,
          widthPx: last.item.width_px,
          lineStyle: last.item.line_style,
          points: last.item.points,
          text: last.item.text,
        })
        if (!item) throw new Error('re-insert returned null')
        const map = new Map(get().byFarm)
        const list = [...(map.get(last.farmId) ?? []), item]
        map.set(last.farmId, list)
        set({
          byFarm: map,
          redoStack: rest,
          undoStack: [
            ...get().undoStack,
            { op: 'add', farmId: last.farmId, item },
          ],
        })
      } else {
        // delete を redo = 実際に delete
        const { error } = await supabase
          .from('map_drawings')
          .delete()
          .eq('id', last.item.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        const list = (map.get(last.farmId) ?? []).filter(
          (s) => s.id !== last.item.id,
        )
        map.set(last.farmId, list)
        set({
          byFarm: map,
          redoStack: rest,
          undoStack: [...get().undoStack, last],
        })
      }
    } catch (err) {
      console.error('[mapDrawingStore] redo failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  invalidate: (farmId) => {
    if (!farmId) {
      set({ byFarm: new Map(), undoStack: [], redoStack: [] })
      return
    }
    const map = new Map(get().byFarm)
    map.delete(farmId)
    set({ byFarm: map, undoStack: [], redoStack: [] })
  },
}))

/** zustand セレクタで stable 空参照 (React error #185 対策) */
export const EMPTY_STROKES: ReadonlyArray<MapDrawingStroke> = Object.freeze([])
