// 工区チャット store。1 farm = 1 チャンネル。
//
// - fetchMessages(farmId) / sendMessage(farmId, body)
// - fetchUnreadCounts(farmIds) で工区一覧のバッジを一括更新
// - markRead(farmId) で自分の最終既読時刻を now() に更新
// - subscribe(farmIds) で Realtime 購読 (新着 INSERT を messages/未読数に反映)

import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

export interface FarmMessage {
  id: string
  farm_id: string
  sender_user_id: string
  body: string
  created_at: string
}

/** 工区あたりのユーザー既読時刻 (自分・他人含む全員) */
export interface FarmReadEntry {
  user_id: string
  last_read_at: string
}

interface State {
  /** farmId → messages (古い順) */
  messagesByFarm: Map<string, FarmMessage[]>
  /** farmId → 未読数 */
  unreadByFarm: Map<string, number>
  /** farmId → 自分の最終既読時刻 (ISO) */
  lastReadByFarm: Map<string, string>
  /** farmId → 全ユーザーの既読情報 (誰がいつ既読になったか) */
  readsByFarm: Map<string, FarmReadEntry[]>
  /** 現在のログイン user_id (subscribe 開始時に固定) */
  _currentUserId: string | null
  /** Realtime + polling のクリーンアップ */
  _cleanup: (() => void) | null

  fetchMessages: (farmId: string) => Promise<FarmMessage[]>
  sendMessage: (
    farmId: string,
    body: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>

  /** 工区一覧に対して未読数と最終既読時刻を一括取得 */
  fetchUnreadCounts: (farmIds: string[]) => Promise<void>

  /** この工区の全ユーザーの既読エントリを取得 */
  fetchReads: (farmId: string) => Promise<void>

  /** 現在時刻で既読フラグを更新。unread も 0 にする */
  markRead: (farmId: string) => Promise<void>

  /** 与えた farm_ids に対して Realtime + 30秒 poll を開始 */
  subscribe: (farmIds: string[]) => void
  unsubscribe: () => void
}

const EMPTY_MESSAGES: FarmMessage[] = []

function extractErr(err: unknown): string {
  if (!err) return 'unknown error'
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export const useFarmChatStore = create<State>((set, get) => ({
  messagesByFarm: new Map(),
  unreadByFarm: new Map(),
  lastReadByFarm: new Map(),
  readsByFarm: new Map(),
  _currentUserId: null,
  _cleanup: null,

  async fetchMessages(farmId) {
    try {
      const { data, error } = await supabase
        .from('farm_messages')
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at', { ascending: true })
        .limit(500)
      if (error) throw error
      const rows = (data ?? []) as FarmMessage[]
      const next = new Map(get().messagesByFarm)
      next.set(farmId, rows)
      set({ messagesByFarm: next })
      return rows
    } catch (err) {
      console.warn('[farmChatStore] fetchMessages failed', err)
      return []
    }
  },

  async sendMessage(farmId, body) {
    const trimmed = body.trim()
    if (!trimmed) return { ok: false, error: '本文が空です' }
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return { ok: false, error: 'not authenticated' }
      const { error } = await supabase.from('farm_messages').insert({
        farm_id: farmId,
        sender_user_id: uid,
        body: trimmed,
      } as never)
      if (error) throw error
      // Realtime callback で messagesByFarm に反映されるが、
      // 反映されない (自分の insert が届かない環境) 場合の保険で
      // 再 fetch する。
      void get().fetchMessages(farmId)
      // 自分が送ったのですぐ既読扱いに
      void get().markRead(farmId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: extractErr(err) }
    }
  },

  async fetchUnreadCounts(farmIds) {
    if (farmIds.length === 0) return
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return

      // 自分の last_read_at を全 farm 分取得
      const { data: reads } = await supabase
        .from('farm_chat_reads')
        .select('farm_id, last_read_at')
        .eq('user_id', uid)
        .in('farm_id', farmIds)
      const readMap = new Map<string, string>()
      for (const r of (reads ?? []) as {
        farm_id: string
        last_read_at: string
      }[]) {
        readMap.set(r.farm_id, r.last_read_at)
      }

      // 対象 farms の全メッセージの (farm_id, created_at) を取ってきて集計
      // (件数が膨大なら別途 RPC 化するが、今のところは十分)
      const { data: msgs } = await supabase
        .from('farm_messages')
        .select('farm_id, created_at, sender_user_id')
        .in('farm_id', farmIds)
      const unread = new Map<string, number>()
      for (const fid of farmIds) unread.set(fid, 0)
      const EPOCH_ZERO = '1970-01-01T00:00:00.000Z'
      for (const m of (msgs ?? []) as {
        farm_id: string
        created_at: string
        sender_user_id: string
      }[]) {
        // 自分の送信は未読カウントに含めない
        if (m.sender_user_id === uid) continue
        const lastRead = readMap.get(m.farm_id) ?? EPOCH_ZERO
        if (new Date(m.created_at).getTime() > new Date(lastRead).getTime()) {
          unread.set(m.farm_id, (unread.get(m.farm_id) ?? 0) + 1)
        }
      }
      const nextLastRead = new Map(get().lastReadByFarm)
      for (const [fid, ts] of readMap) nextLastRead.set(fid, ts)
      set({ unreadByFarm: unread, lastReadByFarm: nextLastRead })
    } catch (err) {
      console.warn('[farmChatStore] fetchUnreadCounts failed', err)
    }
  },

  async fetchReads(farmId) {
    try {
      const { data, error } = await supabase
        .from('farm_chat_reads')
        .select('user_id, last_read_at')
        .eq('farm_id', farmId)
      if (error) throw error
      const rows = (data ?? []) as FarmReadEntry[]
      const next = new Map(get().readsByFarm)
      next.set(farmId, rows)
      set({ readsByFarm: next })
    } catch (err) {
      console.warn('[farmChatStore] fetchReads failed', err)
    }
  },

  async markRead(farmId) {
    try {
      const { data: userData } = await supabase.auth.getUser()
      const uid = userData.user?.id
      if (!uid) return
      const nowIso = new Date().toISOString()
      await supabase
        .from('farm_chat_reads')
        .upsert(
          { farm_id: farmId, user_id: uid, last_read_at: nowIso } as never,
          { onConflict: 'farm_id,user_id' },
        )
      const nextUnread = new Map(get().unreadByFarm)
      nextUnread.set(farmId, 0)
      const nextLast = new Map(get().lastReadByFarm)
      nextLast.set(farmId, nowIso)
      // 全体 reads マップにも自分の分を反映 (Realtime で他ユーザーに配信されるが、
      // 自分の view は即座に更新したい)
      const nextReads = new Map(get().readsByFarm)
      const cur = nextReads.get(farmId) ?? []
      const filtered = cur.filter((r) => r.user_id !== uid)
      filtered.push({ user_id: uid, last_read_at: nowIso })
      nextReads.set(farmId, filtered)
      set({
        unreadByFarm: nextUnread,
        lastReadByFarm: nextLast,
        readsByFarm: nextReads,
      })
    } catch (err) {
      console.warn('[farmChatStore] markRead failed', err)
    }
  },

  subscribe(farmIds) {
    get().unsubscribe()
    void get().fetchUnreadCounts(farmIds)
    // 各 farm の全ユーザー既読も一括取得 (誰が既読か表示に使う)
    for (const fid of farmIds) void get().fetchReads(fid)

    let uid: string | null = null
    void (async () => {
      const { data } = await supabase.auth.getUser()
      uid = data.user?.id ?? null
      set({ _currentUserId: uid })
    })()

    let channel: RealtimeChannel | null = null
    try {
      channel = supabase
        .channel(`farm-messages-${farmIds.slice(0, 3).join('_')}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'farm_messages' },
          (payload) => {
            const row = payload.new as FarmMessage
            if (!row) return
            if (!farmIds.includes(row.farm_id)) return
            // messages 追加
            const msgs = get().messagesByFarm.get(row.farm_id) ?? EMPTY_MESSAGES
            if (msgs.some((m) => m.id === row.id)) return
            const nextMsgs = new Map(get().messagesByFarm)
            nextMsgs.set(row.farm_id, [...msgs, row])
            // 未読数更新 (自分の送信でなく、最終既読より新しい場合)
            const currentUid = get()._currentUserId ?? uid
            let nextUnread = get().unreadByFarm
            if (row.sender_user_id !== currentUid) {
              const lastRead = get().lastReadByFarm.get(row.farm_id)
              const isUnread =
                !lastRead ||
                new Date(row.created_at).getTime() >
                  new Date(lastRead).getTime()
              if (isUnread) {
                nextUnread = new Map(nextUnread)
                nextUnread.set(
                  row.farm_id,
                  (nextUnread.get(row.farm_id) ?? 0) + 1,
                )
              }
            }
            set({ messagesByFarm: nextMsgs, unreadByFarm: nextUnread })
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'farm_chat_reads' },
          (payload) => {
            const row = (payload.new ?? payload.old) as {
              farm_id?: string
              user_id?: string
              last_read_at?: string
            } | null
            if (!row?.farm_id || !row.user_id || !row.last_read_at) return
            if (!farmIds.includes(row.farm_id)) return
            const nextReads = new Map(get().readsByFarm)
            const cur = nextReads.get(row.farm_id) ?? []
            const filtered = cur.filter((r) => r.user_id !== row.user_id)
            if (payload.eventType !== 'DELETE') {
              filtered.push({
                user_id: row.user_id,
                last_read_at: row.last_read_at,
              })
            }
            nextReads.set(row.farm_id, filtered)
            set({ readsByFarm: nextReads })
          },
        )
        .subscribe()
    } catch {
      /* WS 使えない環境 → poll 頼み */
    }

    // 30秒ごとに未読数と既読情報を一括再計算 (Realtime 逃した保険)
    const timer = window.setInterval(() => {
      void get().fetchUnreadCounts(farmIds)
      for (const fid of farmIds) void get().fetchReads(fid)
    }, 30_000)

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
}))
