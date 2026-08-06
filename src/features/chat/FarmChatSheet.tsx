// 工区チャットのモーダルシート。PC/モバイル共通で使う。
// - 起動と同時に fetchMessages + markRead (未読を 0 に)
// - 下部に入力欄、Enter で送信
// - メッセージは自分/他人で左右振り分け

import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Send, Loader2, X } from 'lucide-react'
import { useFarmChatStore } from '@/stores/farmChatStore'
import { supabase } from '@/lib/supabase'

interface Props {
  farmId: string
  farmName: string
  onClose: () => void
}

export function FarmChatSheet({ farmId, farmName, onClose }: Props) {
  const fetchMessages = useFarmChatStore((s) => s.fetchMessages)
  const sendMessage = useFarmChatStore((s) => s.sendMessage)
  const markRead = useFarmChatStore((s) => s.markRead)
  const messages = useFarmChatStore(
    (s) => s.messagesByFarm.get(farmId) ?? EMPTY,
  )

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchMessages(farmId).then(() => {
      void markRead(farmId)
    })
    void supabase.auth
      .getUser()
      .then(({ data }) => setMyUserId(data.user?.id ?? null))
  }, [farmId, fetchMessages, markRead])

  // 新着で最下部にスクロール
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // 送信者名索引 (簡易)
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const need = new Set<string>()
    for (const m of messages) need.add(m.sender_user_id)
    const missing = Array.from(need).filter((id) => !(id in senderNames))
    if (missing.length === 0) return
    void (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('user_id, full_name')
          .in('user_id', missing)
        const upd: Record<string, string> = { ...senderNames }
        for (const row of (data ?? []) as {
          user_id: string
          full_name: string | null
        }[]) {
          upd[row.user_id] = row.full_name ?? ''
        }
        setSenderNames(upd)
      } catch {
        /* noop */
      }
    })()
  }, [messages, senderNames])

  const handleSend = async () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    setError(null)
    const res = await sendMessage(farmId, t)
    setSending(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setText('')
  }

  const sorted = useMemo(() => messages, [messages])

  return (
    <div
      className="fixed inset-0 z-[3500] bg-black/40 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md h-[80vh] rounded-t-2xl sm:rounded-2xl flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <MessageSquare className="h-5 w-5 text-indigo-600" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-500 truncate">工区チャット</div>
            <div className="text-sm font-semibold truncate">{farmName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-2 bg-slate-50">
          {sorted.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-8">
              まだメッセージはありません
            </div>
          ) : (
            sorted.map((m) => {
              const mine = m.sender_user_id === myUserId
              const senderName = senderNames[m.sender_user_id] ?? ''
              return (
                <div
                  key={m.id}
                  className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-2 py-1.5 text-xs shadow-sm ${
                      mine
                        ? 'bg-indigo-100 border border-indigo-200'
                        : 'bg-white border'
                    }`}
                  >
                    <div className="text-[10px] text-slate-500 mb-0.5 flex items-center gap-1">
                      <span className="font-medium">
                        {senderName || (mine ? '自分' : '他ユーザー')}
                      </span>
                      <span>·</span>
                      <span>
                        {new Date(m.created_at).toLocaleString('ja-JP', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap break-words">
                      {m.body}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {error && (
          <div className="px-2 py-1 bg-red-50 border-t border-red-200 text-[10px] text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-1 p-1.5 border-t bg-white">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 px-2 py-1 text-sm border rounded"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className="px-2 py-1 bg-indigo-600 text-white rounded disabled:opacity-40 hover:bg-indigo-700"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// stable reference for zustand selector (毎回 [] を返すと無限再レンダー)
const EMPTY: import('@/stores/farmChatStore').FarmMessage[] = []
