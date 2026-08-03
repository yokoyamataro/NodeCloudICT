// モビリティ 指示 / 報告 / チャット 用ストア。
//
// テーブル: mobility_messages (単一)
// - channel: 'direct' (admin<->driver 1:1) または 'project' (現場メンバー全員)
// - message_kind: 'instruction' | 'confirmation' | 'arrival' | 'note'
//
// RPC:
// - mobility_send_instruction: admin から instruction 送信
// - mobility_confirm_instruction: driver が確認 -> assignment 自動起動
// - mobility_report_arrival: driver 到着 -> assignment 終了
//
// Realtime:
// - mobility_messages を organization_id で購読

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export type MessageChannelKind = 'direct' | 'project'
export type MessageKind = 'instruction' | 'confirmation' | 'arrival' | 'note'
export type SenderRole = 'admin' | 'driver'

export interface MobilityMessage {
  id: string
  organization_id: string
  channel_kind: MessageChannelKind
  channel_user_id: string | null
  channel_project_id: string | null
  sender_user_id: string
  sender_role: SenderRole
  message_kind: MessageKind
  body: string | null
  instruction_vehicle_id: string | null
  instruction_point_id: string | null
  parent_message_id: string | null
  read_at: string | null
  created_at: string
}

function extractErr(err: unknown): string {
  if (!err) return 'unknown error'
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: string; details?: string; hint?: string; code?: string }
    const parts: string[] = []
    if (e.message) parts.push(e.message)
    if (e.details) parts.push(`details=${e.details}`)
    if (e.hint) parts.push(`hint=${e.hint}`)
    if (e.code) parts.push(`code=${e.code}`)
    if (parts.length > 0) return parts.join(' | ')
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

interface State {
  /** organization 内の全メッセージ (新しい順) */
  messages: MobilityMessage[]
  loading: boolean
  error: string | null
  /** Realtime + polling 用のクリーンアップ */
  _cleanup: (() => void) | null

  fetchAll: (organizationId: string) => Promise<void>
  /** organization 全メッセージを購読 + 15秒ポーリング fallback */
  subscribe: (organizationId: string) => void
  unsubscribe: () => void

  sendInstruction: (input: {
    organizationId: string
    channelKind: MessageChannelKind
    channelUserId: string | null
    channelProjectId: string | null
    vehicleId: string | null
    pointId: string
    body: string | null
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>

  /** driver が instruction を確認。成功すると新しく作られた assignment_id を返す (車両未指定なら null) */
  confirmInstruction: (
    instructionId: string,
  ) => Promise<{ ok: true; assignmentId: string | null } | { ok: false; error: string }>

  /** driver 到着報告 (assignment 終了 + arrival メッセージ INSERT) */
  reportArrival: (
    assignmentId: string,
    instructionId: string | null,
  ) => Promise<{ ok: true } | { ok: false; error: string }>

  /** 自由テキスト note を送信 */
  sendNote: (input: {
    organizationId: string
    channelKind: MessageChannelKind
    channelUserId: string | null
    channelProjectId: string | null
    senderRole: SenderRole
    body: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>

  markRead: (messageId: string) => Promise<void>
}

export const useMobilityMessagesStore = create<State>((set, get) => ({
  messages: [],
  loading: false,
  error: null,
  _cleanup: null,

  async fetchAll(organizationId) {
    set({ loading: true, error: null })
    try {
      const { data, error } = (await (supabase as any)
        .from('mobility_messages')
        .select('*')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(500)) as { data: MobilityMessage[] | null; error: unknown }
      if (error) throw error
      set({ messages: data ?? [], loading: false })
    } catch (err) {
      set({ loading: false, error: extractErr(err) })
    }
  },

  subscribe(organizationId) {
    // 二重購読防止
    get().unsubscribe()

    void get().fetchAll(organizationId)

    let channel: RealtimeChannel | null = null
    try {
      channel = supabase
        .channel(`mobility_messages_${organizationId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'mobility_messages',
            filter: `organization_id=eq.${organizationId}`,
          },
          (payload) => {
            const cur = get().messages
            if (payload.eventType === 'INSERT') {
              const row = payload.new as MobilityMessage
              if (cur.some((m) => m.id === row.id)) return
              set({ messages: [row, ...cur] })
            } else if (payload.eventType === 'UPDATE') {
              const row = payload.new as MobilityMessage
              set({ messages: cur.map((m) => (m.id === row.id ? row : m)) })
            } else if (payload.eventType === 'DELETE') {
              const oldRow = payload.old as MobilityMessage
              set({ messages: cur.filter((m) => m.id !== oldRow.id) })
            }
          },
        )
        .subscribe()
    } catch {
      // WebSocket が使えない環境ではポーリングに全振り
    }

    // 15秒ポーリング fallback
    const timer = window.setInterval(() => {
      void get().fetchAll(organizationId)
    }, 15000)

    set({
      _cleanup: () => {
        if (channel) {
          try {
            void supabase.removeChannel(channel)
          } catch {
            /* noop */
          }
        }
        window.clearInterval(timer)
      },
    })
  },

  unsubscribe() {
    const c = get()._cleanup
    if (c) c()
    set({ _cleanup: null })
  },

  async sendInstruction({
    organizationId,
    channelKind,
    channelUserId,
    channelProjectId,
    vehicleId,
    pointId,
    body,
  }) {
    try {
      const { data, error } = (await supabase.rpc(
        'mobility_send_instruction' as never,
        {
          p_organization_id: organizationId,
          p_channel_kind: channelKind,
          p_channel_user_id: channelUserId,
          p_channel_project_id: channelProjectId,
          p_vehicle_id: vehicleId,
          p_point_id: pointId,
          p_body: body,
        } as never,
      )) as { data: string | null; error: unknown }
      if (error) throw error
      return { ok: true, id: data as string }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  async confirmInstruction(instructionId) {
    try {
      const { data, error } = (await supabase.rpc(
        'mobility_confirm_instruction' as never,
        { p_instruction_id: instructionId } as never,
      )) as { data: string | null; error: unknown }
      if (error) throw error
      return { ok: true, assignmentId: data ?? null }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  async reportArrival(assignmentId, instructionId) {
    try {
      const { error } = (await supabase.rpc(
        'mobility_report_arrival' as never,
        {
          p_assignment_id: assignmentId,
          p_instruction_id: instructionId,
        } as never,
      )) as { error: unknown }
      if (error) throw error
      return { ok: true }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  async sendNote({
    organizationId,
    channelKind,
    channelUserId,
    channelProjectId,
    senderRole,
    body,
  }) {
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return { ok: false, error: 'not authenticated' }

      const { data, error } = (await (supabase as any)
        .from('mobility_messages')
        .insert({
          organization_id: organizationId,
          channel_kind: channelKind,
          channel_user_id: channelUserId,
          channel_project_id: channelProjectId,
          sender_user_id: uid,
          sender_role: senderRole,
          message_kind: 'note',
          body,
        })
        .select('id')
        .single()) as { data: { id: string } | null; error: unknown }
      if (error) throw error
      return { ok: true, id: data?.id ?? '' }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  async markRead(messageId) {
    try {
      await (supabase as any)
        .from('mobility_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('id', messageId)
        .is('read_at', null)
    } catch {
      /* noop */
    }
  },
}))

/**
 * 2点間距離 (m) — 到着判定用の Haversine。
 * ドライバー側で「目的地から 100m 以内なら到着報告可」を判定するのに使う。
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
