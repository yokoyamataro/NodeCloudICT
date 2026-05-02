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

export interface OpenChannelRow {
  id: string
  farmId: string
  name: string
  /** 床幅 W (m) */
  floorWidth: number
  /** 斜面勾配 1:i の i 値 */
  slopeRatio: number
  /** 設計法面深さ(m, 任意) */
  bankHeight: number | null
  alignmentPoints: AlignmentPoint[]
  notes: string | null
}

interface OpenChannelDb {
  id: string
  farm_id: string
  name: string
  floor_width: number | string
  slope_ratio: number | string
  bank_height: number | string | null
  alignment_points: AlignmentPoint[]
  notes: string | null
}

function toRow(d: OpenChannelDb): OpenChannelRow {
  return {
    id: d.id,
    farmId: d.farm_id,
    name: d.name,
    floorWidth: Number(d.floor_width),
    slopeRatio: Number(d.slope_ratio),
    bankHeight: d.bank_height != null ? Number(d.bank_height) : null,
    alignmentPoints: Array.isArray(d.alignment_points) ? d.alignment_points : [],
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
      set({ loading: false, error: e instanceof Error ? e.message : '小水路の取得に失敗' })
    }
  },

  addChannel: async (farmId, name) => {
    try {
      const existing = get().channels.length
      const insert = {
        farm_id: farmId,
        name: name ?? `小水路 ${existing + 1}`,
        floor_width: 0.5,
        slope_ratio: 1.0,
        bank_height: null,
        alignment_points: [],
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
      set({ error: e instanceof Error ? e.message : '小水路の追加に失敗' })
      return null
    }
  },

  updateChannel: async (id, updates) => {
    try {
      const dbUpdates: Record<string, unknown> = {}
      if (updates.name !== undefined) dbUpdates.name = updates.name
      if (updates.floorWidth !== undefined) dbUpdates.floor_width = updates.floorWidth
      if (updates.slopeRatio !== undefined) dbUpdates.slope_ratio = updates.slopeRatio
      if (updates.bankHeight !== undefined) dbUpdates.bank_height = updates.bankHeight
      if (updates.alignmentPoints !== undefined) dbUpdates.alignment_points = updates.alignmentPoints
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
      set({ error: e instanceof Error ? e.message : '小水路の更新に失敗' })
    }
  },

  deleteChannel: async (id) => {
    try {
      set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }))
      const { error } = await supabase.from('open_channels').delete().eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '小水路の削除に失敗' })
    }
  },
}))
