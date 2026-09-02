import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type AlignmentPointKind = 'bp' | 'ip' | 'ep'

export interface AlignmentPoint {
  /** 座標管理の design_coordinates の id を参照 */
  coordId: string
  kind: AlignmentPointKind
  /** IP の単曲線半径 (m)。0 または未指定で直角折れ */
  radius?: number
  /** IP の IN 側クロソイドパラメータ A (m)。0/未指定で緩和曲線なし */
  spiralAIn?: number
  /** IP の OUT 側クロソイドパラメータ A (m)。0/未指定で緩和曲線なし */
  spiralAOut?: number
}

/** 縦断線形の変化点 */
export interface ProfilePoint {
  /** BP からの追加距離 (m) */
  distance: number
  /** 床高 (m, 標高) */
  floorHeight: number
  /**
   * 縦断曲線長 VCL (m)。省略 or 0 なら 角折れ (曲線なし)。
   * この 変化点 を PVI (勾配変化点) として BVC=PVI-VCL/2、EVC=PVI+VCL/2 に
   * 対称 2 次放物線 を 割り付ける。両端 の 変化点 (BP/EP) では 無視。
   */
  vcl?: number
}

/** 勾配の表記単位
 *  - 'ratio'    : 1:i 表記（slopeValue=i, 符号で上下）
 *  - 'percent'  : i % 表記（slopeValue=i, 符号で上下）
 *  - 'vertical' : 直立（水平 0 のまま slopeValue 分だけ高さ変化、+ で上り、- で下り）
 */
export type SlopeUnit = 'ratio' | 'percent' | 'vertical'

/**
 * 標準断面の 1 要素（中心からの 1 区間）。
 *
 * - `width` は水平方向の幅 (m, 正値)。`slopeUnit='vertical'` のときは無視され 0 として扱う。
 * - `slopeValue` は数値で、符号は外側に向かう向きでの上下を表す:
 *   + = 上り（外側に向かって上がる）/ - = 下り。
 *   - `slopeUnit='ratio'`: 「1:value」と解釈。0 は不可（フラットは percent 0% を使用）。
 *   - `slopeUnit='percent'`: 「value %」と解釈（0% フラット）。
 *   - `slopeUnit='vertical'`: 高さ (m) として解釈。dx=0, dy=slopeValue。
 * - `name` はラベル（床 / 法面 / 道路部 など）。色分け等の将来拡張用。
 */
export interface CrossSectionElement {
  id: string
  name: string
  width: number
  slopeValue: number
  slopeUnit: SlopeUnit
}

export interface StandardCrossSection {
  /** 中心 → 右側へ並ぶ要素列 */
  right: CrossSectionElement[]
  /** 中心 → 左側へ並ぶ要素列 */
  left: CrossSectionElement[]
}

export const emptyStandardCrossSection = (): StandardCrossSection => ({ right: [], left: [] })

/**
 * 測定 断面 点 (現況 / 出来形 用)。中心線からの 垂直方向 距離 (offset) と 標高。
 *   offset > 0 = 右側、offset < 0 = 左側 (WidthStake と 同じ 慣習、sideOrientation に 従う)
 *   note: 地図から 拾った 場合 の 元 座標番号 等 の 任意メモ
 */
export interface MeasuredCrossPoint {
  id: string
  offset: number
  elevation: number
  note?: string
}

/** 中間点（測点）。SP / BC / EC / IP などラベル付きで BP からの距離 + 個別断面を保持。 */
export interface StationRow {
  id: string
  /** 表示ラベル（SP12.50 / BC34.20 / IP25.00 等） */
  label: string
  /** BP からの追加距離 (m) */
  distance: number
  /** 個別断面。null / 未指定なら標準断面を使用。 */
  crossSection: StandardCrossSection | null
  /**
   * 現況高 (中心線上の 地盤高) [m]。手入力。null / 未指定なら 未計測扱い。
   * 計画高 (縦断線形 由来) と 差分を 取って 切土/盛土 の 判定 に 使う。
   * currentSection が 中心 (offset=0) を 含む 場合 は そちらが 優先される。
   */
  currentGroundHeight?: number | null
  /**
   * 現況断面 (地盤 の 実測点列)。offset (中心からの 離れ) と 標高 の ペア。
   * 地図の 測点マーカーから 取得 (中心線 に 垂直投影) するか、モーダルから 直接入力。
   */
  currentSection?: MeasuredCrossPoint[] | null
  /**
   * 出来形 断面 (施工後の 実測点列)。現状 プレースホルダ (次ステップで 実装予定)。
   */
  asbuiltSection?: MeasuredCrossPoint[] | null
}

/**
 * 幅杭。追加距離 (BP からの 内部距離) と 中心線 から の 垂直方向 オフセット
 * (進行方向 右手 が +、左手 が -) を 指定して 平面 XY を 算出する。
 */
export interface WidthStake {
  id: string
  /** BP からの 内部 累積距離 (m) */
  distance: number
  /** 中心線 から の 垂直 オフセット (m)。右 が +、左 が -。 */
  offset: number
  /** 任意 メモ (点名 等) */
  note?: string
}

/** 断面の右/左を判定する基準方向。
 *  - 'forward': BP→EP を見て右/左（道路工事の慣習、デフォルト）
 *  - 'reverse': EP→BP を見て右/左（河川工事の慣習）
 */
export type SideOrientation = 'forward' | 'reverse'

export interface OpenChannelRow {
  id: string
  farmId: string
  name: string
  /** 標準断面（要素列） */
  standardCrossSection: StandardCrossSection
  alignmentPoints: AlignmentPoint[]
  /** 縦断線形（変化点列） */
  profilePoints: ProfilePoint[]
  /** 中間点（測点）リスト */
  stations: StationRow[]
  /** 左右の基準方向 */
  sideOrientation: SideOrientation
  /**
   * 先頭測点 (BP) の SP オフセット。デフォルト 0。
   * 路線 の 途中 から IP を 入力する 場合 (例: BP を SP 224.69 に 設定) に、
   * 中間点計算 の SP ラベル が 元路線 と 揃う ように する。
   * 内部距離 (BP からの 累積距離) との 関係: SP = 内部距離 + spOffset
   */
  spOffset: number
  /** 幅杭 (SP + 中心線 から の 垂直方向 オフセット で 定義 する 点) */
  widthStakes: WidthStake[]
  notes: string | null
}

interface OpenChannelDb {
  id: string
  farm_id: string
  name: string
  standard_cross_section: StandardCrossSection | null
  alignment_points: AlignmentPoint[]
  profile_points: ProfilePoint[] | null
  stations: StationRow[] | null
  side_orientation: SideOrientation | null
  sp_offset: number | null
  width_stakes: WidthStake[] | null
  notes: string | null
}

function normalizeCrossSection(raw: unknown): StandardCrossSection {
  if (!raw || typeof raw !== 'object') return emptyStandardCrossSection()
  const r = raw as Partial<StandardCrossSection>
  return {
    right: Array.isArray(r.right) ? (r.right as CrossSectionElement[]) : [],
    left: Array.isArray(r.left) ? (r.left as CrossSectionElement[]) : [],
  }
}

function toRow(d: OpenChannelDb): OpenChannelRow {
  return {
    id: d.id,
    farmId: d.farm_id,
    name: d.name,
    standardCrossSection: normalizeCrossSection(d.standard_cross_section),
    alignmentPoints: Array.isArray(d.alignment_points) ? d.alignment_points : [],
    profilePoints: Array.isArray(d.profile_points) ? d.profile_points : [],
    stations: Array.isArray(d.stations) ? d.stations : [],
    sideOrientation: d.side_orientation === 'reverse' ? 'reverse' : 'forward',
    spOffset: Number.isFinite(Number(d.sp_offset)) ? Number(d.sp_offset) : 0,
    widthStakes: Array.isArray(d.width_stakes) ? d.width_stakes : [],
    notes: d.notes,
  }
}

interface OpenChannelState {
  channels: OpenChannelRow[]
  loading: boolean
  error: string | null

  fetchChannels: (farmId: string) => Promise<void>
  addChannel: (farmId: string, name?: string) => Promise<OpenChannelRow | null>
  updateChannel: (id: string, updates: Partial<Omit<OpenChannelRow, 'id' | 'farmId'>>) => Promise<void>
  deleteChannel: (id: string) => Promise<void>
}

export const useOpenChannelStore = create<OpenChannelState>()((set, get) => ({
  channels: [],
  loading: false,
  error: null,

  fetchChannels: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('open_channels')
        .select('*')
        .eq('farm_id', farmId)
        .order('name')
      if (error) throw error
      set({
        channels: ((data || []) as unknown as OpenChannelDb[]).map(toRow),
        loading: false,
      })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '線形物の取得に失敗' })
    }
  },

  addChannel: async (farmId, name) => {
    try {
      const existing = get().channels.length
      const insert = {
        farm_id: farmId,
        name: name ?? `線形物 ${existing + 1}`,
        standard_cross_section: emptyStandardCrossSection(),
        alignment_points: [],
        profile_points: [],
        stations: [],
        side_orientation: 'forward',
        sp_offset: 0,
        width_stakes: [],
        notes: null,
      }
      const { data, error } = await supabase
        .from('open_channels')
        .insert(insert as never)
        .select()
        .single()
      if (error) throw error
      const row = toRow(data as unknown as OpenChannelDb)
      set((s) => ({ channels: [...s.channels, row] }))
      return row
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の追加に失敗' })
      return null
    }
  },

  updateChannel: async (id, updates) => {
    try {
      const dbUpdates: Record<string, unknown> = {}
      if (updates.name !== undefined) dbUpdates.name = updates.name
      if (updates.standardCrossSection !== undefined)
        dbUpdates.standard_cross_section = updates.standardCrossSection
      if (updates.alignmentPoints !== undefined) dbUpdates.alignment_points = updates.alignmentPoints
      if (updates.profilePoints !== undefined) dbUpdates.profile_points = updates.profilePoints
      if (updates.stations !== undefined) dbUpdates.stations = updates.stations
      if (updates.sideOrientation !== undefined) dbUpdates.side_orientation = updates.sideOrientation
      if (updates.spOffset !== undefined) dbUpdates.sp_offset = updates.spOffset
      if (updates.widthStakes !== undefined) dbUpdates.width_stakes = updates.widthStakes
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes
      // 楽観的更新
      set((s) => ({
        channels: s.channels.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      }))
      const { error } = await supabase
        .from('open_channels')
        .update(dbUpdates as never)
        .eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の更新に失敗' })
    }
  },

  deleteChannel: async (id) => {
    try {
      set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }))
      const { error } = await supabase.from('open_channels').delete().eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の削除に失敗' })
    }
  },
}))

/** 要素 1 区間の "外側 1m あたり何 m 上昇するか"（符号付き）。vertical 用ではない。 */
export function elementSlopePerMeter(e: CrossSectionElement): number {
  if (e.slopeUnit === 'percent') return e.slopeValue / 100
  if (e.slopeUnit === 'ratio') {
    if (Math.abs(e.slopeValue) < 1e-9) return 0
    return Math.sign(e.slopeValue) * (1 / Math.abs(e.slopeValue))
  }
  return 0 // vertical: 水平変化なし（dy は slopeValue を直接用いる）
}

/**
 * 要素 1 区間の (dx, dy) を返す。`sideSign=+1` で右側、`-1` で左側。
 *  - 'ratio' / 'percent': dx = sideSign * width, dy = width * slopeFactor
 *  - 'vertical'         : dx = 0, dy = slopeValue
 */
export function elementStep(
  e: CrossSectionElement,
  sideSign: 1 | -1,
): { dx: number; dy: number } {
  if (e.slopeUnit === 'vertical') return { dx: 0, dy: e.slopeValue }
  const slopeFactor = elementSlopePerMeter(e)
  return { dx: sideSign * e.width, dy: e.width * slopeFactor }
}

/** 標準断面を、中心 (0,0) を含む 2D 折れ線（左端 → 右端）に展開する。 */
export function buildCrossSectionPath(cs: StandardCrossSection): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  // 左側：中心から外側へ展開し、配列を逆順にして先頭に置く
  let cx = 0
  let cy = 0
  const leftPoints: { x: number; y: number }[] = []
  for (const e of cs.left) {
    const { dx, dy } = elementStep(e, -1)
    cx += dx
    cy += dy
    leftPoints.push({ x: cx, y: cy })
  }
  out.push(...leftPoints.reverse())
  out.push({ x: 0, y: 0 })
  cx = 0
  cy = 0
  for (const e of cs.right) {
    const { dx, dy } = elementStep(e, 1)
    cx += dx
    cy += dy
    out.push({ x: cx, y: cy })
  }
  return out
}

/** 勾配を人間可読な文字列に整形。 */
export function formatSlope(e: CrossSectionElement): string {
  const trim = (n: number, d = 2) => n.toFixed(d).replace(/\.?0+$/, '')
  if (e.slopeUnit === 'vertical') {
    if (Math.abs(e.slopeValue) < 1e-9) return '直立0m'
    return e.slopeValue > 0 ? `↑${trim(e.slopeValue)}m` : `↓${trim(-e.slopeValue)}m`
  }
  if (e.slopeUnit === 'percent') {
    if (Math.abs(e.slopeValue) < 1e-9) return '0%'
    return `${e.slopeValue >= 0 ? '+' : ''}${trim(e.slopeValue)}%`
  }
  if (Math.abs(e.slopeValue) < 1e-9) return '水平'
  const sign = e.slopeValue < 0 ? '↓' : '↑'
  return `1:${trim(Math.abs(e.slopeValue))}${sign}`
}

/**
 * 断面 1 区間 の コンパクト 表記 を パース する。
 *
 * 各 区間 は 2 値 を カンマ 区切り で 記述:
 *   -2%,2.000       → 勾配 -2% と 水平距離 dW=2m
 *   +1.0,-1.0       → dW=+1m と dH=-1m (両方 距離指定、勾配 は 自動計算)
 *   1:1.5,H-5.0     → 勾配 1:1.5 と 垂直距離 dH=-5m (H 接頭辞 で dH 指定)
 *   -1:1.5,2.000    → 勾配 1:1.5 下向き と 水平距離 2m
 *   0,H1.5          → 直立 上向き 1.5m (dW=0)
 *
 * 各 トークン の 判別:
 *   - `%` で 終わる      → 勾配 (%)
 *   - `1:...` を 含む   → 勾配 (1:i、符号 は 上下)
 *   - `H` / `h` 接頭辞 → 垂直距離 dH (符号付き)
 *   - それ以外         → 水平距離 dW (符号付き)
 *
 * 戻り値 は CrossSectionElement の (width, slopeValue, slopeUnit) 部分。
 */
export function parseSegmentNotation(
  text: string,
): Pick<CrossSectionElement, 'width' | 'slopeValue' | 'slopeUnit'> | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length !== 2) return null

  type Token =
    | { kind: 'percent'; value: number }
    | { kind: 'ratio'; value: number }
    | { kind: 'dW'; value: number }
    | { kind: 'dH'; value: number }

  const parseToken = (s: string): Token | null => {
    const ratioMatch = s.match(/^([+-]?)1:([+-]?\d+(?:\.\d+)?)$/)
    if (ratioMatch) {
      const sign = ratioMatch[1] === '-' ? -1 : 1
      const v = parseFloat(ratioMatch[2])
      if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return null
      return { kind: 'ratio', value: sign * Math.abs(v) }
    }
    const pctMatch = s.match(/^([+-]?\d+(?:\.\d+)?)%$/)
    if (pctMatch) {
      const v = parseFloat(pctMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'percent', value: v }
    }
    const dhMatch = s.match(/^[Hh]([+-]?\d+(?:\.\d+)?)$/)
    if (dhMatch) {
      const v = parseFloat(dhMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'dH', value: v }
    }
    const dwMatch = s.match(/^([+-]?\d+(?:\.\d+)?)$/)
    if (dwMatch) {
      const v = parseFloat(dwMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'dW', value: v }
    }
    return null
  }

  const t1 = parseToken(parts[0])
  const t2 = parseToken(parts[1])
  if (!t1 || !t2) return null

  const distTok =
    t1.kind === 'dW' || t1.kind === 'dH'
      ? t1
      : t2.kind === 'dW' || t2.kind === 'dH'
      ? t2
      : null
  const slopeTok =
    t1.kind === 'percent' || t1.kind === 'ratio'
      ? t1
      : t2.kind === 'percent' || t2.kind === 'ratio'
      ? t2
      : null

  // (距離 + 勾配) の 組合せ
  if (distTok && slopeTok) {
    if (distTok.kind === 'dW') {
      const width = Math.abs(distTok.value)
      if (slopeTok.kind === 'percent') {
        return { width, slopeValue: slopeTok.value, slopeUnit: 'percent' }
      }
      return { width, slopeValue: slopeTok.value, slopeUnit: 'ratio' }
    }
    // dH + 勾配 → 幅 を 逆算
    const dh = distTok.value
    if (Math.abs(dh) < 1e-9) {
      // dH=0 なら 幅 0 の 水平点 (無意味)
      return { width: 0, slopeValue: 0, slopeUnit: slopeTok.kind }
    }
    if (slopeTok.kind === 'percent') {
      const factor = slopeTok.value / 100
      if (Math.abs(factor) < 1e-9) return null
      const width = Math.abs(dh / factor)
      // 勾配 の 符号 は dH に 合わせる (下り なら 負)
      const signedSlope = Math.sign(dh) * Math.abs(slopeTok.value)
      return { width, slopeValue: signedSlope, slopeUnit: 'percent' }
    }
    // ratio: dH = width * sign / |i| → width = |dH * i|
    const i = Math.abs(slopeTok.value)
    const width = Math.abs(dh * i)
    const signedSlope = Math.sign(dh) * i
    return { width, slopeValue: signedSlope, slopeUnit: 'ratio' }
  }

  // (dW + dH) の 組合せ → 勾配 % を 算出
  const dwTok = t1.kind === 'dW' ? t1 : t2.kind === 'dW' ? t2 : null
  const dhTok = t1.kind === 'dH' ? t1 : t2.kind === 'dH' ? t2 : null
  if (dwTok && dhTok) {
    const dw = dwTok.value
    const dh = dhTok.value
    const width = Math.abs(dw)
    if (width < 1e-9) {
      return { width: 0, slopeValue: dh, slopeUnit: 'vertical' }
    }
    const pct = (dh / width) * 100
    return { width, slopeValue: pct, slopeUnit: 'percent' }
  }

  // (勾配 + 勾配) は 不定
  return null
}

/**
 * CrossSectionElement を コンパクト 表記 (parseSegmentNotation の 逆) に 整形。
 */
export function formatSegmentNotation(e: CrossSectionElement): string {
  const trim = (n: number, d = 3) => {
    const s = n.toFixed(d)
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s
  }
  if (e.slopeUnit === 'vertical') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `0,H${sign}${trim(e.slopeValue)}`
  }
  if (e.slopeUnit === 'percent') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `${sign}${trim(e.slopeValue, 2)}%,${trim(e.width)}`
  }
  // ratio
  const sign = e.slopeValue < 0 ? '-' : ''
  return `${sign}1:${trim(Math.abs(e.slopeValue), 2)},${trim(e.width)}`
}
