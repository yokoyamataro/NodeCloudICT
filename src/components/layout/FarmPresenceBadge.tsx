// 工区 (farm) 単位 の Presence バッジ。 同じ farm を 別 端末/別 タブ で 開いて いる
// 他 セッション を 小さな バッジで ヘッダー に 表示 する。
//
// 実装: Supabase Realtime Presence API
//   channel(`farm-presence-${farmId}`, { config: { presence: { key: <tab-uid> } } })
//     .on('presence', { event: 'sync' }, () => ...)
//     .subscribe(async (status) => { if (SUBSCRIBED) await channel.track({ payload }) })
//
// 自分 の 別 端末 は 別 セッション として 表示 する (tabId で 区別)。
// バッジ の 数字 は 自分以外 の セッション 数。 マウスホバー で 名前一覧 を 出す。

import { useEffect, useMemo, useState } from 'react'
import { Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

interface PresencePayload {
  userId: string
  displayName: string
  tabId: string
  joinedAt: string
}

// タブ ローカル な 一意 ID。 module load 時 に 1 度だけ 生成 (同一タブ 内 で 使い回し)。
// 別 タブ = 別 モジュール インスタンス = 別 tabId → 別 セッション として 見える。
const TAB_ID =
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * 工区 単位 の 他 セッション リスト を 返す。
 * farmId が null (工区 未選択) の 間 は 空配列 を 返す。
 */
function useFarmPresence(farmId: string | null): PresencePayload[] {
  const { user, displayName } = useAuth()
  const [others, setOthers] = useState<PresencePayload[]>([])

  useEffect(() => {
    if (!farmId || !user?.id) {
      setOthers([])
      return
    }

    const myKey = `${user.id}-${TAB_ID}`
    const payload: PresencePayload = {
      userId: user.id,
      displayName: (displayName ?? '').trim() || user.email || '(名前未設定)',
      tabId: TAB_ID,
      joinedAt: new Date().toISOString(),
    }

    const channel = supabase.channel(`farm-presence-${farmId}`, {
      config: { presence: { key: myKey } },
    })

    const syncOthers = () => {
      const state = channel.presenceState<PresencePayload>()
      const list: PresencePayload[] = []
      for (const [key, entries] of Object.entries(state)) {
        if (key === myKey) continue
        for (const e of entries) list.push(e)
      }
      // 参加時刻 で 安定 ソート (視覚 上 の 入れ替わり を 抑制)
      list.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      setOthers(list)
    }

    channel
      .on('presence', { event: 'sync' }, syncOthers)
      .on('presence', { event: 'join' }, syncOthers)
      .on('presence', { event: 'leave' }, syncOthers)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          try {
            await channel.track(payload)
          } catch (e) {
            console.error('[farm-presence track]', e)
          }
        }
      })

    return () => {
      try {
        void channel.untrack()
      } catch {
        /* ignore */
      }
      void supabase.removeChannel(channel)
    }
  }, [farmId, user?.id, displayName, user?.email])

  return others
}

/**
 * ヘッダー 用 の 小さな バッジ。 他 セッション が 1 件 以上 ある ときのみ 描画。
 * 表示: 👤 <count>  (hover で 名前一覧 を tooltip)
 */
export function FarmPresenceBadge({ farmId }: { farmId: string | null }) {
  const others = useFarmPresence(farmId)
  const summary = useMemo(() => {
    if (others.length === 0) return ''
    // 名前 は 重複 (同一ユーザー の 別 タブ) を 「◯◯ (2)」 の 形 に まとめる
    const counts = new Map<string, number>()
    for (const o of others) counts.set(o.displayName, (counts.get(o.displayName) ?? 0) + 1)
    return Array.from(counts.entries())
      .map(([name, n]) => (n > 1 ? `${name} (${n})` : name))
      .join(', ')
  }, [others])

  if (others.length === 0) return null

  return (
    <span
      className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-amber-500/20 text-amber-200 border border-amber-500/40"
      title={`他 に 開いて いる セッション: ${summary}`}
    >
      <Users className="h-3 w-3" />
      <span className="tabular-nums">{others.length}</span>
    </span>
  )
}
