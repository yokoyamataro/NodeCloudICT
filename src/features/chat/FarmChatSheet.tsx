// 工区チャットのモーダルシート。PC/モバイル共通で使う。
// - 起動と同時に fetchMessages + markRead (未読を 0 に)
// - 下部に入力欄、Enter で送信
// - メッセージは自分/他人で左右振り分け

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MessageSquare, Send, Loader2, X } from 'lucide-react'
import { useFarmChatStore } from '@/stores/farmChatStore'
import { supabase } from '@/lib/supabase'

interface Props {
  farmId: string
  farmName: string
  /** メンション候補用にプロジェクトメンバーを引くための projectId。
   *  未指定なら @ メンションは無効化される (機能無し)。 */
  projectId?: string | null
  onClose: () => void
}

/** メンション候補メンバー (簡易) */
interface MentionMember {
  user_id: string
  display_name: string
}

export function FarmChatSheet({ farmId, farmName, projectId, onClose }: Props) {
  const fetchMessages = useFarmChatStore((s) => s.fetchMessages)
  const fetchReads = useFarmChatStore((s) => s.fetchReads)
  const sendMessage = useFarmChatStore((s) => s.sendMessage)
  const markRead = useFarmChatStore((s) => s.markRead)
  const messages = useFarmChatStore(
    (s) => s.messagesByFarm.get(farmId) ?? EMPTY,
  )
  const reads = useFarmChatStore(
    (s) => s.readsByFarm.get(farmId) ?? EMPTY_READS,
  )

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // メンション候補のメンバー一覧
  const [members, setMembers] = useState<MentionMember[]>([])
  useEffect(() => {
    if (!projectId) return
    void (async () => {
      try {
        const { data, error } = await (
          supabase.rpc as unknown as (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: unknown }>
        )('get_project_members', { p_project_id: projectId })
        if (error) throw error
        const rows = (data ?? []) as Array<{
          user_id: string
          display_name?: string | null
          email?: string | null
        }>
        setMembers(
          rows.map((r) => ({
            user_id: r.user_id,
            display_name:
              (r.display_name && r.display_name.trim()) ||
              (r.email ? r.email.split('@')[0] : '') ||
              r.user_id.slice(0, 6),
          })),
        )
      } catch (err) {
        console.warn('[FarmChatSheet] fetch members failed', err)
      }
    })()
  }, [projectId])

  // @ メンション: 入力中の @ で始まる部分を追跡
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStartIdx, setMentionStartIdx] = useState<number | null>(null)
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)
  const detectMention = (value: string, caret: number) => {
    // caret 位置から左方向に @ を探し、@ 以降が空白/改行を含まなければメンション中とみなす
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i]
      if (ch === '@') {
        // @ の直前が英数字なら (メール内の @) メンションではない
        const prev = i > 0 ? value[i - 1] : ''
        if (prev && /[\w]/.test(prev)) return null
        return { start: i, query: value.slice(i + 1, caret) }
      }
      if (ch === ' ' || ch === '\n' || ch === '\t') return null
    }
    return null
  }
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [] as MentionMember[]
    const q = mentionQuery.toLowerCase()
    return members
      .filter(
        (m) =>
          m.user_id !== myUserId &&
          (q === '' || m.display_name.toLowerCase().includes(q)),
      )
      .slice(0, 8)
  }, [mentionQuery, members, myUserId])

  const insertMention = (m: MentionMember) => {
    if (mentionStartIdx == null || !inputRef.current) return
    const caret = inputRef.current.selectionStart ?? text.length
    const before = text.slice(0, mentionStartIdx)
    const after = text.slice(caret)
    // 表示は "@名前 " をそのまま挿入 (ID は本文に埋め込まない)
    const inserted = `@${m.display_name} `
    const nextText = before + inserted + after
    setText(nextText)
    setMentionQuery(null)
    setMentionStartIdx(null)
    setMentionActiveIdx(0)
    // カーソルを挿入後の位置に
    const newCaret = before.length + inserted.length
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(newCaret, newCaret)
      inputRef.current?.focus()
    })
  }

  useEffect(() => {
    void fetchMessages(farmId).then(() => {
      void markRead(farmId)
    })
    void fetchReads(farmId)
    void supabase.auth
      .getUser()
      .then(({ data }) => setMyUserId(data.user?.id ?? null))
  }, [farmId, fetchMessages, fetchReads, markRead])

  // 新着で最下部にスクロール
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // 送信者 + 既読ユーザーの名前索引
  // profiles を直引きすると RLS (自分 or site_owner のみ SELECT 可) で他人の行が
  // 弾かれるため、SECURITY DEFINER の get_project_members RPC (→ members) を
  // 権威ソースにする。get_project_members は profiles.full_name → auth 側の
  // full_name/name/display_name → email ローカル部 のフォールバック済み。
  const senderNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const m of members) map[m.user_id] = m.display_name
    return map
  }, [members])

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
              // このメッセージを既読にしているユーザー (送信者本人を除く)
              const readersForMsg = reads.filter(
                (r) =>
                  r.user_id !== m.sender_user_id &&
                  new Date(r.last_read_at).getTime() >=
                    new Date(m.created_at).getTime(),
              )
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
                      {renderBodyWithMentions(m.body)}
                    </div>
                    {mine && readersForMsg.length > 0 && (
                      <div
                        className="text-[9px] text-slate-400 mt-1 text-right"
                        title={readersForMsg
                          .map(
                            (r) =>
                              `${senderNames[r.user_id] || r.user_id.slice(0, 6)} (${new Date(r.last_read_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })})`,
                          )
                          .join('\n')}
                      >
                        既読{' '}
                        {readersForMsg
                          .map(
                            (r) =>
                              senderNames[r.user_id] || r.user_id.slice(0, 6),
                          )
                          .join(', ')}
                      </div>
                    )}
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

        <div className="relative flex gap-1 p-1.5 border-t bg-white">
          {/* メンション候補ドロップダウン (入力欄の上に浮かせる) */}
          {mentionQuery !== null && mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-1.5 mb-1 z-10 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto min-w-[180px]">
              {mentionCandidates.map((m, i) => (
                <button
                  key={m.user_id}
                  type="button"
                  onMouseDown={(e) => {
                    // input の blur より前に発火させる
                    e.preventDefault()
                    insertMention(m)
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 ${
                    i === mentionActiveIdx ? 'bg-indigo-100' : ''
                  }`}
                >
                  @{m.display_name}
                </button>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              const caret = e.target.selectionStart ?? v.length
              const m = detectMention(v, caret)
              if (m) {
                setMentionStartIdx(m.start)
                setMentionQuery(m.query)
                setMentionActiveIdx(0)
              } else {
                setMentionQuery(null)
                setMentionStartIdx(null)
              }
            }}
            onKeyDown={(e) => {
              // メンション候補表示中は方向キー・Enter で候補選択
              if (mentionQuery !== null && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionActiveIdx((i) =>
                    Math.min(i + 1, mentionCandidates.length - 1),
                  )
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionActiveIdx((i) => Math.max(i - 1, 0))
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  const m = mentionCandidates[mentionActiveIdx]
                  if (m) insertMention(m)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionQuery(null)
                  setMentionStartIdx(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={
              projectId
                ? 'メッセージを入力 (@ でメンション)...'
                : 'メッセージを入力...'
            }
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
const EMPTY_READS: import('@/stores/farmChatStore').FarmReadEntry[] = []

// 本文中の "@名前" を色付き表示にする。
// マッチ規則: 先頭 or 空白直後の @ に非空白が続くもの (末尾は空白/改行/句読/文末で切る)
function renderBodyWithMentions(body: string): ReactNode {
  const parts: ReactNode[] = []
  const re = /(^|\s)(@[^\s、。,.!?！？]+)/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const [full, lead, mention] = m
    const startOfMention = m.index + lead.length
    if (startOfMention > lastIdx) {
      parts.push(body.slice(lastIdx, startOfMention))
    }
    parts.push(
      <span
        key={`m-${startOfMention}`}
        className="text-indigo-700 font-medium bg-indigo-50 rounded px-0.5"
      >
        {mention}
      </span>,
    )
    lastIdx = m.index + full.length
  }
  if (lastIdx < body.length) parts.push(body.slice(lastIdx))
  return parts
}
