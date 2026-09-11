// 工区 (farm) 単位 の Presence バッジ。 同じ farm を 別 端末/別 タブ で 開いて いる
// 他 セッション を 小さな バッジで ヘッダー に 表示 する。
//
// 実装: Supabase Realtime Presence API
//   channel(`farm-presence-${farmId}`, { config: { presence: { key: <tab-uid> } } })
//     .on('presence', { event: 'sync' }, () => ...)
//     .subscribe(async (status) => { if (SUBSCRIBED) await channel.track({ payload }) })
//
// 自分 の 別 端末 は 別 セッション として 表示 する (tabId で 区別)。
// 自分以外 の 人 を 頭文字 の 丸 で 並べる。 ホバー で フルネーム。
// 丸 を 押す と 親 が その人 宛て の チャット を 開く (onSelectUser)。

import { useEffect, useMemo, useState } from 'react'
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
/** 表示名 の 先頭 1 文字。 英字 は 大文字 に する */
function initialOf(name: string): string {
  const c = Array.from(name.trim())[0] ?? '?'
  return /[a-z]/.test(c) ? c.toUpperCase() : c
}

export function FarmPresenceBadge({
  farmId,
  onSelectUser,
}: {
  farmId: string | null
  /**
   * 丸 を 押した とき。 その人 宛て の メンション を 打つ 想定。
   * 渡さ なければ ただの 表示 (押せない)。
   */
  onSelectUser?: (u: { userId: string; displayName: string }) => void
}) {
  const others = useFarmPresence(farmId)

  // 同じ 人 が 複数 タブ で 開いて いる ことが ある ので 人 単位 に まとめる
  const people = useMemo(() => {
    const m = new Map<string, { userId: string; displayName: string; tabs: number }>()
    for (const o of others) {
      const hit = m.get(o.userId)
      if (hit) hit.tabs += 1
      else m.set(o.userId, { userId: o.userId, displayName: o.displayName, tabs: 1 })
    }
    return Array.from(m.values())
  }, [others])

  if (people.length === 0) return null

  return (
    <span className="ml-2 inline-flex items-center gap-0.5">
      {people.map((p) => {
        const label = p.tabs > 1 ? `${p.displayName} (${p.tabs})` : p.displayName
        return (
          <button
            key={p.userId}
            type="button"
            onClick={onSelectUser ? () => onSelectUser(p) : undefined}
            title={
              onSelectUser
                ? `${label} — 押すと この人 宛て に チャットを 書く`
                : label
            }
            aria-label={label}
            className={`w-6 h-6 shrink-0 inline-flex items-center justify-center rounded-full text-[11px] font-bold bg-amber-500/25 text-amber-100 border border-amber-400/50 ${
              onSelectUser ? 'hover:bg-amber-500/50 hover:text-white' : 'cursor-default'
            }`}
          >
            {initialOf(p.displayName)}
          </button>
        )
      })}
    </span>
  )
}
