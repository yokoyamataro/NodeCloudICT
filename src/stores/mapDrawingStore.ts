// 地図上のペイント (map_drawings) を工区単位でキャッシュ + CRUD するストア。
//
// 種別 (kind):
//   ・'stroke'  手書きストローク: 頂点列 (n 点)
//   ・'text'    テキスト注釈: [ラベル位置] の 1 点 + text
//   ・'circle'  円: [中心, 縁] の 2 点。半径 = 2 点間距離
//   ・'arc'     円弧: [始点, 通過点, 終点] の 3 点
//   ・'polygon' 面: 頂点列 (n 点、レンダ時に自動閉合、半透明で塗り潰し)
//   ・'point'   点: [位置] の 1 点
//   ・'frame'   図枠: 外枠 [左下, 右下, 右上, 左上] の 4 点。内枠を 付けたものは
//               続けて 内枠の 4 点を 持つ (計 8 点)。塗らない。
//               色 / 線種 / 線幅は 固定 (黄・実線) で、置いたあとは 形も 属性も
//               変えられない (動かせるのは 移動と 回転だけ)。
//               用紙 / 縮尺 / 内枠の オフセット / 原点 / 向き は frame 列に 残す
//               (点列だけだと 「A3 の 1/1000」 が あとから 分からないため)
//
// layer は DXF 出力時のレイヤ名 (未指定は CAD の既定レイヤ '0')。
// font_size は kind='text' の文字サイズ [px]。NULL の既存データは width_px から換算する。
//
// undo/redo:
//   ・セッション内の add / delete / update 操作を undoStack に積む
//   ・undo: 操作を反転して DB + ストアに反映、redoStack に移動
//   ・新規操作が入ったら redoStack はクリア

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type DrawingKind =
  | 'stroke'
  | 'text'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'point'
  | 'frame'

/**
 * 線の端部の矢印。UI では 始点 / 終点 それぞれ 線か矢印かを 選ばせ、
 * その組み合わせを この 4 通りに まとめて 持つ。
 */
export type ArrowStyle = 'none' | 'start' | 'end' | 'both'

/** 線上文字を 線のどこに 置くか */
export type TextAnchor = 'center' | 'above' | 'below'

export const TEXT_ANCHOR_LABEL: Record<TextAnchor, string> = {
  center: '真ん中',
  above: '上',
  below: '下',
}

/** 文字を 基準点の 左右どちら側に 置くか */
export type TextAlign = 'left' | 'center' | 'right'

export const TEXT_ALIGN_LABEL: Record<TextAlign, string> = {
  left: '左',
  center: '中央',
  right: '右',
}

/** ピック (スナップ) で 吸着させる対象の種類 */
export type SnapType = 'vertex' | 'intersection' | 'center' | 'edge'

export const SNAP_TYPE_LABEL: Record<SnapType, string> = {
  vertex: '単点',
  intersection: '交点',
  center: '中心点',
  edge: '線上',
}

/** 既定で 有効にする種類。線上は 当たりが広く 誤爆しやすいので 既定は外す */
export const DEFAULT_SNAP_TYPES: SnapType[] = ['vertex', 'intersection', 'center']

/**
 * 図枠 専用のレイヤ名。図枠は 必ず ここに入り、既定では 一番下 (奥) に置く。
 * 他の作図と 混ぜると 並べ替えの たびに 前後してしまうため。
 */
export const FRAME_LAYER = '図枠'

/**
 * 図枠の 見た目は 固定で、色 / 線種 / 線幅は 選ばせない。
 * 用紙の 枠は 下地なので 作図と 見分けが つけば よく、空中写真の 上でも
 * 沈まない 黄色に 揃える。
 */
export const FRAME_COLOR = '#eab308'
/** 図枠の 線幅 [px] */
export const FRAME_WIDTH_PX = 2

/** レイヤ名の既定候補。現場でまず使う 4 つ + 図枠 */
export const DEFAULT_LAYERS = ['現況', '建物', '道路', '計画', FRAME_LAYER] as const

/** 種別の表示名 (属性パネルなどで使う) */
export const KIND_LABEL: Record<DrawingKind, string> = {
  stroke: '線',
  polygon: '面',
  circle: '円',
  arc: '円弧',
  text: '文字',
  point: '点',
  frame: '図枠',
}

/**
 * 図枠 (kind='frame') の 素性。点列は これを 地図に 焼いた 結果なので、
 * 用紙や 縮尺は ここに 残す。移動 / 回転では origin と angleDeg も 一緒に 直す。
 */
export interface FrameSpec {
  /** 用紙 ('A4'〜'A0' / 'free') */
  paper: string
  /** 横置きか */
  landscape: boolean
  /** 置いた 用紙の 実寸 [mm] (向きを 当てはめた あとの 値) */
  widthMm: number
  heightMm: number
  /** 縮尺の 分母 (1/scale) */
  scale: number
  /** 内枠の 外枠からの オフセット [用紙 mm]。内枠なしは null */
  inset: { left: number; right: number; top: number; bottom: number } | null
  /** 外枠の 左下 */
  origin: { lat: number; lng: number }
  /** 幅の向き [度]。東を 0 とした 反時計回り */
  angleDeg: number
}

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
  /** DXF 出力時のレイヤ名 */
  layer: string
  /** kind='text' の文字サイズ [px]。NULL なら width_px から換算 */
  font_size: number | null
  /** kind='text' の回転角 [度]。反時計回りが正。0 = 水平文字 */
  rotation_deg: number
  /** kind='stroke' / 'arc' の端部の矢印 */
  arrow: ArrowStyle
  /** kind='text' を 線のどこに 置くか (線上文字用) */
  text_anchor: TextAnchor
  /** kind='text' を 基準点の 左右どちらに 寄せるか */
  text_align: TextAlign
  /** kind='frame' の 素性 (用紙 / 縮尺 / 内枠 / 原点 / 向き)。他の種別は null */
  frame: FrameSpec | null
  created_at: string
  updated_at: string
}

/** undo/redo で扱う操作履歴 */
type HistoryOp =
  | { op: 'add'; farmId: string; item: MapDrawingStroke }
  | { op: 'delete'; farmId: string; item: MapDrawingStroke }
  | {
      op: 'update'
      farmId: string
      id: string
      before: Array<{ lat: number; lng: number }>
      after: Array<{ lat: number; lng: number }>
      /** 図枠を 動かしたときは 素性も 一緒に 戻す (undo を 1 回で 済ませる) */
      beforeFrame?: FrameSpec | null
      afterFrame?: FrameSpec | null
    }
  | {
      op: 'attrs'
      farmId: string
      id: string
      before: StrokeAttrs
      after: StrokeAttrs
    }

/** 選択して後から変えられる属性 (頂点以外) */
export interface StrokeAttrs {
  color?: string
  widthPx?: number
  lineStyle?: LineStyle
  layer?: string
  text?: string
  fontSize?: number | null
  rotationDeg?: number
  arrow?: ArrowStyle
  textAnchor?: TextAnchor
  textAlign?: TextAlign
}

/** StrokeAttrs → DB カラム名 */
function attrsToColumns(a: StrokeAttrs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (a.color !== undefined) out.color = a.color
  if (a.widthPx !== undefined) out.width_px = a.widthPx
  if (a.lineStyle !== undefined) out.line_style = a.lineStyle
  if (a.layer !== undefined) out.layer = a.layer
  if (a.text !== undefined) out.text = a.text
  if (a.fontSize !== undefined) out.font_size = a.fontSize
  if (a.rotationDeg !== undefined) out.rotation_deg = a.rotationDeg
  if (a.arrow !== undefined) out.arrow = a.arrow
  if (a.textAnchor !== undefined) out.text_anchor = a.textAnchor
  if (a.textAlign !== undefined) out.text_align = a.textAlign
  return out
}

/** StrokeAttrs をストア上のアイテムへ当てる */
function applyAttrs(item: MapDrawingStroke, a: StrokeAttrs): MapDrawingStroke {
  return {
    ...item,
    color: a.color ?? item.color,
    width_px: a.widthPx ?? item.width_px,
    line_style: a.lineStyle ?? item.line_style,
    layer: a.layer ?? item.layer,
    text: a.text !== undefined ? a.text : item.text,
    font_size: a.fontSize !== undefined ? a.fontSize : item.font_size,
    rotation_deg: a.rotationDeg ?? item.rotation_deg,
    arrow: a.arrow ?? item.arrow,
    text_anchor: a.textAnchor ?? item.text_anchor,
    text_align: a.textAlign ?? item.text_align,
  }
}

/** 変更前の値を、変更しようとしている項目だけ抜き出す (undo 用) */
function pickAttrs(item: MapDrawingStroke, a: StrokeAttrs): StrokeAttrs {
  const out: StrokeAttrs = {}
  if (a.color !== undefined) out.color = item.color
  if (a.widthPx !== undefined) out.widthPx = item.width_px
  if (a.lineStyle !== undefined) out.lineStyle = item.line_style
  if (a.layer !== undefined) out.layer = item.layer
  if (a.text !== undefined) out.text = item.text ?? ''
  if (a.fontSize !== undefined) out.fontSize = item.font_size
  if (a.rotationDeg !== undefined) out.rotationDeg = item.rotation_deg
  if (a.arrow !== undefined) out.arrow = item.arrow
  if (a.textAnchor !== undefined) out.textAnchor = item.text_anchor
  if (a.textAlign !== undefined) out.textAlign = item.text_align
  return out
}

interface State {
  byFarm: Map<string, MapDrawingStroke[]>
  loadingFarms: Set<string>
  error: string | null
  undoStack: HistoryOp[]
  redoStack: HistoryOp[]

  fetchByFarm: (farmId: string) => Promise<void>
  /**
   * ストロークまたは幾何形状 (直線・円・円弧・面) を追加する汎用 API。
   * kind を省略すると 'stroke' (フリーハンド) 扱い。
   */
  addStroke: (input: {
    farmId: string
    kind?: 'stroke' | 'circle' | 'arc' | 'polygon' | 'frame'
    color: string
    widthPx: number
    lineStyle: LineStyle
    points: Array<{ lat: number; lng: number }>
    layer?: string
    arrow?: ArrowStyle
    /** kind='frame' の 素性 */
    frame?: FrameSpec | null
  }) => Promise<MapDrawingStroke | null>
  addText: (input: {
    farmId: string
    color: string
    widthPx: number
    lat: number
    lng: number
    text: string
    layer?: string
    fontSize?: number
    rotationDeg?: number
    textAnchor?: TextAnchor
    textAlign?: TextAlign
  }) => Promise<MapDrawingStroke | null>
  /** 単独の点。座標管理への登録は呼び出し側で行う (点自体はここに残す) */
  addPoint: (input: {
    farmId: string
    color: string
    widthPx: number
    lat: number
    lng: number
    layer?: string
  }) => Promise<MapDrawingStroke | null>
  deleteStroke: (id: string) => Promise<void>
  /** 色 / 太さ / 線種 / レイヤ / 文字などの属性を差し替える (図枠は 変えない) */
  updateStrokeAttrs: (id: string, attrs: StrokeAttrs) => Promise<void>
  /**
   * 頂点座標列を差し替える (端点移動 / 折点追加・削除)。
   * 図枠を 移動 / 回転したときは、素性 (原点・向き) も 一緒に 渡す。
   */
  updateStrokePoints: (
    id: string,
    points: Array<{ lat: number; lng: number }>,
    frame?: FrameSpec | null,
  ) => Promise<void>
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
    layer?: string
    fontSize?: number | null
    rotationDeg?: number
    arrow?: ArrowStyle
    textAnchor?: TextAnchor
    textAlign?: TextAlign
    frame?: FrameSpec | null
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
      layer: input.layer ?? '0',
      font_size: input.fontSize ?? null,
      rotation_deg: input.rotationDeg ?? 0,
      arrow: input.arrow ?? 'none',
      text_anchor: input.textAnchor ?? 'center',
      text_align: input.textAlign ?? 'center',
      frame: input.frame ?? null,
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

  addStroke: async ({
    farmId,
    kind = 'stroke',
    color,
    widthPx,
    lineStyle,
    points,
    layer = '0',
    arrow = 'none',
    frame = null,
  }) => {
    if (points.length < 2) return null
    // 楽観追加: temp ID で先にストアに入れる
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: MapDrawingStroke = {
      id: tempId,
      farm_id: farmId,
      created_by: null,
      kind,
      color,
      width_px: widthPx,
      line_style: lineStyle,
      points,
      text: null,
      layer,
      font_size: null,
      rotation_deg: 0,
      arrow,
      text_anchor: 'center',
      text_align: 'center',
      frame,
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
        kind,
        color,
        widthPx,
        lineStyle,
        points,
        text: null,
        layer,
        arrow,
        frame,
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

  addText: async ({
    farmId,
    color,
    widthPx,
    lat,
    lng,
    text,
    layer = '0',
    fontSize,
    rotationDeg = 0,
    textAnchor = 'center',
    textAlign = 'center',
  }) => {
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
      layer,
      font_size: fontSize ?? null,
      rotation_deg: rotationDeg,
      arrow: 'none',
      text_anchor: textAnchor,
      text_align: textAlign,
      frame: null,
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
        layer,
        fontSize: fontSize ?? null,
        rotationDeg,
        textAnchor,
        textAlign,
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

  addPoint: async ({ farmId, color, widthPx, lat, lng, layer = '0' }) => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const optimistic: MapDrawingStroke = {
      id: tempId,
      farm_id: farmId,
      created_by: null,
      kind: 'point',
      color,
      width_px: widthPx,
      line_style: 'solid',
      points: [{ lat, lng }],
      text: null,
      layer,
      font_size: null,
      rotation_deg: 0,
      arrow: 'none',
      text_anchor: 'center',
      text_align: 'center',
      frame: null,
      created_at: now,
      updated_at: now,
    }
    {
      const map = new Map(get().byFarm)
      map.set(farmId, [...(map.get(farmId) ?? []), optimistic])
      set({ byFarm: map })
    }
    try {
      const item = await insertItemInternal({
        farmId,
        kind: 'point',
        color,
        widthPx,
        lineStyle: 'solid',
        points: [{ lat, lng }],
        text: null,
        layer,
      })
      if (!item) throw new Error('insert returned null')
      const map = new Map(get().byFarm)
      map.set(
        farmId,
        (map.get(farmId) ?? []).map((s) => (s.id === tempId ? item : s)),
      )
      set({
        byFarm: map,
        undoStack: [...get().undoStack, { op: 'add', farmId, item }],
        redoStack: [],
      })
      return item
    } catch (err) {
      console.error('[mapDrawingStore] add point failed', err)
      const map = new Map(get().byFarm)
      map.set(farmId, (map.get(farmId) ?? []).filter((s) => s.id !== tempId))
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

  updateStrokeAttrs: async (id, attrs) => {
    // 変更前を控えつつ楽観的に反映
    let farmId: string | null = null
    let before: StrokeAttrs | null = null
    {
      const map = new Map(get().byFarm)
      for (const [fid, list] of map.entries()) {
        const idx = list.findIndex((s) => s.id === id)
        if (idx >= 0) {
          // 図枠は 見た目もレイヤも 固定。選択に 混ざっていても 変えない。
          // 位置と 向きは updateStrokePoints (点列 + 素性) で 直す
          if (list[idx].kind === 'frame') return
          farmId = fid
          before = pickAttrs(list[idx], attrs)
          const next = [...list]
          next[idx] = applyAttrs(list[idx], attrs)
          map.set(fid, next)
          set({ byFarm: map })
          break
        }
      }
    }
    if (!farmId || !before) return
    const columns = attrsToColumns(attrs)
    if (Object.keys(columns).length === 0) return
    try {
      const { error } = await supabase
        .from('map_drawings')
        .update(columns as never)
        .eq('id', id)
      if (error) throw error
      set({
        undoStack: [...get().undoStack, { op: 'attrs', farmId, id, before, after: attrs }],
        redoStack: [],
      })
    } catch (err) {
      // ロールバック
      console.error('[mapDrawingStore] update attrs failed', err)
      const cur = new Map(get().byFarm)
      const list = cur.get(farmId) ?? []
      const idx = list.findIndex((s) => s.id === id)
      if (idx >= 0) {
        const next = [...list]
        next[idx] = applyAttrs(list[idx], before)
        cur.set(farmId, next)
        set({ byFarm: cur, error: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  updateStrokePoints: async (id, points, frame) => {
    // 現在の points を before として控えつつ、楽観的に置換
    let farmId: string | null = null
    let before: Array<{ lat: number; lng: number }> | null = null
    let beforeFrame: FrameSpec | null = null
    // 図枠を 移動 / 回転したとき。素性 (原点・向き) も 点列と 一緒に 直す
    const withFrame = frame !== undefined
    {
      const map = new Map(get().byFarm)
      for (const [fid, list] of map.entries()) {
        const idx = list.findIndex((s) => s.id === id)
        if (idx >= 0) {
          farmId = fid
          before = list[idx].points
          beforeFrame = list[idx].frame
          const next = [...list]
          next[idx] = { ...list[idx], points, ...(withFrame ? { frame: frame ?? null } : {}) }
          map.set(fid, next)
          set({ byFarm: map })
          break
        }
      }
    }
    if (!farmId || !before) return
    try {
      const { error } = await supabase
        .from('map_drawings')
        .update({ points, ...(withFrame ? { frame: frame ?? null } : {}) } as never)
        .eq('id', id)
      if (error) throw error
      set({
        undoStack: [
          ...get().undoStack,
          {
            op: 'update',
            farmId,
            id,
            before,
            after: points,
            ...(withFrame ? { beforeFrame, afterFrame: frame ?? null } : {}),
          },
        ],
        redoStack: [],
      })
    } catch (err) {
      // ロールバック
      const cur = new Map(get().byFarm)
      const list = (cur.get(farmId) ?? []).map((s) =>
        s.id === id
          ? { ...s, points: before as Array<{ lat: number; lng: number }> }
          : s,
      )
      cur.set(farmId, list)
      set({
        byFarm: cur,
        error: err instanceof Error ? err.message : String(err),
      })
      console.error('[mapDrawingStore] update failed', err)
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
      } else if (last.op === 'attrs') {
        // attrs を undo = before に戻す
        const { error } = await supabase
          .from('map_drawings')
          .update(attrsToColumns(last.before) as never)
          .eq('id', last.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        map.set(
          last.farmId,
          (map.get(last.farmId) ?? []).map((s) =>
            s.id === last.id ? applyAttrs(s, last.before) : s,
          ),
        )
        set({
          byFarm: map,
          undoStack: rest,
          redoStack: [...get().redoStack, last],
        })
      } else if (last.op === 'update') {
        // update を undo = before に戻す (図枠は 素性も 一緒に)
        const undoFrame = last.beforeFrame !== undefined ? { frame: last.beforeFrame } : {}
        const { error } = await supabase
          .from('map_drawings')
          .update({ points: last.before, ...undoFrame } as never)
          .eq('id', last.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        const list = (map.get(last.farmId) ?? []).map((s) =>
          s.id === last.id ? { ...s, points: last.before, ...undoFrame } : s,
        )
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
          layer: last.item.layer,
          fontSize: last.item.font_size,
          rotationDeg: last.item.rotation_deg,
          arrow: last.item.arrow,
          textAnchor: last.item.text_anchor,
          textAlign: last.item.text_align,
          frame: last.item.frame,
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
          layer: last.item.layer,
          fontSize: last.item.font_size,
          rotationDeg: last.item.rotation_deg,
          arrow: last.item.arrow,
          textAnchor: last.item.text_anchor,
          textAlign: last.item.text_align,
          frame: last.item.frame,
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
      } else if (last.op === 'attrs') {
        // attrs を redo = after に戻す
        const { error } = await supabase
          .from('map_drawings')
          .update(attrsToColumns(last.after) as never)
          .eq('id', last.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        map.set(
          last.farmId,
          (map.get(last.farmId) ?? []).map((s) =>
            s.id === last.id ? applyAttrs(s, last.after) : s,
          ),
        )
        set({
          byFarm: map,
          redoStack: rest,
          undoStack: [...get().undoStack, last],
        })
      } else if (last.op === 'update') {
        // update を redo = after に戻す (図枠は 素性も 一緒に)
        const redoFrame = last.afterFrame !== undefined ? { frame: last.afterFrame } : {}
        const { error } = await supabase
          .from('map_drawings')
          .update({ points: last.after, ...redoFrame } as never)
          .eq('id', last.id)
        if (error) throw error
        const map = new Map(get().byFarm)
        const list = (map.get(last.farmId) ?? []).map((s) =>
          s.id === last.id ? { ...s, points: last.after, ...redoFrame } : s,
        )
        map.set(last.farmId, list)
        set({
          byFarm: map,
          redoStack: rest,
          undoStack: [...get().undoStack, last],
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
