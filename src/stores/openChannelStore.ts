import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type AlignmentPointKind = 'bp' | 'ip' | 'ep'

export interface AlignmentPoint {
  /** 座標管理の design_coordinates の id を参照 */
  coordId: string
  kind: AlignmentPointKind
  /** IP の単曲線半径 (m)。0 または未指定で直角折れ */
  radius?: number
}

/** 縦断線形の変化点 */
export interface ProfilePoint {
  /** BP からの追加距離 (m) */
  distance: number
  /** 床高 (m, 標高) */
  floorHeight: number
}

/** 勾配の表記単位 */
export type SlopeUnit = 'ratio' | 'percent'

/**
 * 標準断面の 1 要素（中心からの 1 区間）。
 *
 * - `width` は水平方向の幅 (m, 正値)。
 * - `slopeValue` は数値で、符号は外側に向かう向きでの上下を表す:
 *   + = 上り（外側に向かって上がる）/ - = 下り。
 *   - `slopeUnit='ratio'`: 「1:value」と解釈。0 は不可（フラットは percent 0% を使用）。
 *   - `slopeUnit='percent'`: 「value %」と解釈（0% フラット）。
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

/** 中間点（測点）。SP / BC / EC / IP などラベル付きで BP からの距離 + 個別断面を保持。 */
export interface StationRow {
  id: string
  /** 表示ラベル（SP12.50 / BC34.20 / IP25.00 等） */
  label: string
  /** BP からの追加距離 (m) */
  distance: number
  /** 個別断面。null / 未指定なら標準断面を使用。 */
  crossSection: StandardCrossSection | null
}

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

/** 要素 1 区間の "外側 1m あたり何 m 上昇するか"（符号付き）。 */
export function elementSlopePerMeter(e: CrossSectionElement): number {
  if (e.slopeUnit === 'percent') return e.slopeValue / 100
  if (Math.abs(e.slopeValue) < 1e-9) return 0
  return Math.sign(e.slopeValue) * (1 / Math.abs(e.slopeValue))
}

/** 標準断面を、中心 (0,0) を含む 2D 折れ線（左端 → 右端）に展開する。 */
export function buildCrossSectionPath(cs: StandardCrossSection): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  // 左側：中心から外側へ展開し、配列を逆順にして先頭に置く
  let cx = 0
  let cy = 0
  const leftPoints: { x: number; y: number }[] = []
  for (const e of cs.left) {
    cx += -e.width
    cy += e.width * elementSlopePerMeter(e)
    leftPoints.push({ x: cx, y: cy })
  }
  out.push(...leftPoints.reverse())
  out.push({ x: 0, y: 0 })
  cx = 0
  cy = 0
  for (const e of cs.right) {
    cx += e.width
    cy += e.width * elementSlopePerMeter(e)
    out.push({ x: cx, y: cy })
  }
  return out
}

/** 勾配を人間可読な文字列に整形（例: "1:0.5"、"-2.0%"、"水平"）。 */
export function formatSlope(e: CrossSectionElement): string {
  if (e.slopeUnit === 'percent') {
    if (Math.abs(e.slopeValue) < 1e-9) return '0%'
    return `${e.slopeValue >= 0 ? '+' : ''}${e.slopeValue.toFixed(2).replace(/\.?0+$/, '')}%`
  }
  if (Math.abs(e.slopeValue) < 1e-9) return '水平'
  const sign = e.slopeValue < 0 ? '↓' : '↑'
  return `1:${Math.abs(e.slopeValue).toFixed(2).replace(/\.?0+$/, '')}${sign}`
}
