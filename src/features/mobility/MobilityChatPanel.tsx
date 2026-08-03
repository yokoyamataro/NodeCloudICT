// チャットパネル: 指定チャンネル (direct or project) のメッセージを時系列表示 + note 送信
// 指示 (instruction) には確認状態 (子 confirmation の有無) と到着状態を表示

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  MapPin,
  Car,
  Send,
  Flag,
  MessageSquare,
} from 'lucide-react'
import {
  useMobilityMessagesStore,
  type MobilityMessage,
  type MessageChannelKind,
  type SenderRole,
} from '@/stores/mobilityMessagesStore'
import { useMobilityStore } from '@/stores/mobilityStore'
import { supabase } from '@/lib/supabase'

interface Props {
  organizationId: string
  channelKind: MessageChannelKind
  channelUserId: string | null
  channelProjectId: string | null
  senderRole: SenderRole
  /** driver 側からの表示時に「確認」ボタンを表示するかどうか (自分宛 instruction にのみ表示) */
  showDriverConfirm?: boolean
  /** driver が確認済みで、現在稼働中の assignment を持っているとき */
  activeAssignmentId?: string | null
  currentLat?: number | null
  currentLon?: number | null
  onConfirmed?: (assignmentId: string | null) => void
  onArrived?: () => void
  /** 表示件数の上限 (default 30) */
  displayLimit?: number
}

export function MobilityChatPanel({
  organizationId,
  channelKind,
  channelUserId,
  channelProjectId,
  senderRole,
  showDriverConfirm = false,
  activeAssignmentId = null,
  currentLat = null,
  currentLon = null,
  onConfirmed,
  onArrived,
  displayLimit = 30,
}: Props) {
  const {
    messages,
    sendNote,
    confirmInstruction,
    reportArrival,
    markRead,
  } = useMobilityMessagesStore()
  const { vehicles } = useMobilityStore()

  const [noteText, setNoteText] = useState('')
  const [sending, setSending] = useState(false)
  const [busyInstructionId, setBusyInstructionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // このチャンネル分のみ抽出 (新しい順で store 保持しているので反転)
  const channelMessages = useMemo(() => {
    const filtered = messages.filter((m) => {
      if (m.channel_kind !== channelKind) return false
      if (channelKind === 'direct') return m.channel_user_id === channelUserId
      return m.channel_project_id === channelProjectId
    })
    // 古い→新しいで表示
    return filtered.slice().reverse().slice(-displayLimit)
  }, [messages, channelKind, channelUserId, channelProjectId, displayLimit])

  // 子メッセージ (confirmation / arrival) を parent_message_id で索引
  const childrenByParent = useMemo(() => {
    const m = new Map<string, MobilityMessage[]>()
    for (const msg of messages) {
      if (msg.parent_message_id) {
        const arr = m.get(msg.parent_message_id) ?? []
        arr.push(msg)
        m.set(msg.parent_message_id, arr)
      }
    }
    return m
  }, [messages])

  // ポイント名索引 (destination 情報を出すためだけの軽量取得)
  const [pointNames, setPointNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const need = new Set<string>()
    for (const m of channelMessages) {
      if (m.instruction_point_id) need.add(m.instruction_point_id)
    }
    const missing = Array.from(need).filter((id) => !(id in pointNames))
    if (missing.length === 0) return
    void (async () => {
      try {
        const { data } = await supabase
          .from('mobility_project_points')
          .select('id, name')
          .in('id', missing)
        const upd: Record<string, string> = { ...pointNames }
        for (const row of (data ?? []) as { id: string; name: string }[]) {
          upd[row.id] = row.name
        }
        setPointNames(upd)
      } catch {
        /* noop */
      }
    })()
  }, [channelMessages, pointNames])

  // 送信者名索引
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  useEffect(() => {
    const need = new Set<string>()
    for (const m of channelMessages) need.add(m.sender_user_id)
    const missing = Array.from(need).filter((id) => !(id in senderNames))
    if (missing.length === 0) return
    void (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('user_id, full_name')
          .in('user_id', missing)
        const upd: Record<string, string> = { ...senderNames }
        for (const row of (data ?? []) as { user_id: string; full_name: string | null }[]) {
          upd[row.user_id] = row.full_name ?? ''
        }
        setSenderNames(upd)
      } catch {
        /* noop */
      }
    })()
  }, [channelMessages, senderNames])

  // 新着表示時に一番下へスクロール + 自分宛の未読を read にする
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    for (const m of channelMessages) {
      if (!m.read_at && m.channel_kind === 'direct' && m.channel_user_id) {
        void markRead(m.id)
      }
    }
  }, [channelMessages, markRead])

  const handleSendNote = async () => {
    const t = noteText.trim()
    if (!t || sending) return
    setSending(true)
    setError(null)
    const res = await sendNote({
      organizationId,
      channelKind,
      channelUserId,
      channelProjectId,
      senderRole,
      body: t,
    })
    setSending(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setNoteText('')
  }

  const handleConfirm = async (instructionId: string) => {
    setBusyInstructionId(instructionId)
    setError(null)
    const res = await confirmInstruction(instructionId)
    setBusyInstructionId(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onConfirmed?.(res.assignmentId)
  }

  const handleArrival = async (instructionId: string) => {
    if (!activeAssignmentId) return
    setBusyInstructionId(instructionId)
    setError(null)
    const res = await reportArrival(activeAssignmentId, instructionId)
    setBusyInstructionId(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onArrived?.()
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-50 rounded border">
      {/* メッセージ一覧 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-2">
        {channelMessages.length === 0 && (
          <div className="text-center text-xs text-slate-400 py-6">
            まだメッセージはありません
          </div>
        )}
        {channelMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            senderName={senderNames[m.sender_user_id] ?? ''}
            pointName={
              m.instruction_point_id
                ? pointNames[m.instruction_point_id] ?? '(ポイント)'
                : null
            }
            vehicleName={
              m.instruction_vehicle_id
                ? vehicles.find((v) => v.id === m.instruction_vehicle_id)?.name ?? null
                : null
            }
            children_={childrenByParent.get(m.id) ?? []}
            viewerRole={senderRole}
            showDriverConfirm={showDriverConfirm}
            currentLat={currentLat}
            currentLon={currentLon}
            activeAssignmentId={activeAssignmentId}
            busyInstructionId={busyInstructionId}
            onConfirm={handleConfirm}
            onArrival={handleArrival}
          />
        ))}
      </div>

      {error && (
        <div className="px-2 py-1 bg-red-50 border-t border-red-200 text-[10px] text-red-700">
          {error}
        </div>
      )}

      {/* note 送信入力 */}
      <div className="flex gap-1 p-1.5 border-t bg-white">
        <input
          type="text"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSendNote()
            }
          }}
          placeholder="メッセージを入力..."
          className="flex-1 px-2 py-1 text-sm border rounded"
        />
        <button
          type="button"
          onClick={handleSendNote}
          disabled={!noteText.trim() || sending}
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
  )
}

// -----------------------------------------------------------------------------
// メッセージバブル
// -----------------------------------------------------------------------------
function MessageBubble({
  message,
  senderName,
  pointName,
  vehicleName,
  children_,
  viewerRole,
  showDriverConfirm,
  currentLat,
  currentLon,
  activeAssignmentId,
  busyInstructionId,
  onConfirm,
  onArrival,
}: {
  message: MobilityMessage
  senderName: string
  pointName: string | null
  vehicleName: string | null
  children_: MobilityMessage[]
  viewerRole: SenderRole
  showDriverConfirm: boolean
  currentLat: number | null
  currentLon: number | null
  activeAssignmentId: string | null
  busyInstructionId: string | null
  onConfirm: (id: string) => void
  onArrival: (id: string) => void
}) {
  const isMine = message.sender_role === viewerRole
  const time = new Date(message.created_at).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })

  const confirmed = children_.some((c) => c.message_kind === 'confirmation')
  const arrived = children_.some((c) => c.message_kind === 'arrival')

  // 到着ボタンを有効化する距離判定 (100m)
  const [pointLatLon, setPointLatLon] = useState<{ lat: number; lon: number } | null>(
    null,
  )
  useEffect(() => {
    if (message.message_kind !== 'instruction' || !message.instruction_point_id) return
    void (async () => {
      try {
        const { data } = (await (supabase as any)
          .from('mobility_project_points')
          .select('lat, lon')
          .eq('id', message.instruction_point_id!)
          .maybeSingle()) as { data: { lat: number; lon: number } | null }
        if (data) setPointLatLon({ lat: data.lat, lon: data.lon })
      } catch {
        /* noop */
      }
    })()
  }, [message.instruction_point_id, message.message_kind])

  const distanceM = useMemo(() => {
    if (!pointLatLon || currentLat == null || currentLon == null) return null
    const R = 6371_000
    const toRad = (d: number) => (d * Math.PI) / 180
    const dLat = toRad(pointLatLon.lat - currentLat)
    const dLon = toRad(pointLatLon.lon - currentLon)
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(currentLat)) *
        Math.cos(toRad(pointLatLon.lat)) *
        Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }, [pointLatLon, currentLat, currentLon])

  const withinArrivalRange = distanceM != null && distanceM <= 100

  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded px-2 py-1.5 text-xs shadow-sm ${
          message.message_kind === 'instruction'
            ? 'bg-amber-50 border border-amber-300'
            : message.message_kind === 'confirmation'
              ? 'bg-emerald-50 border border-emerald-200'
              : message.message_kind === 'arrival'
                ? 'bg-blue-50 border border-blue-200'
                : isMine
                  ? 'bg-indigo-100 border border-indigo-200'
                  : 'bg-white border'
        }`}
      >
        <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-0.5">
          <span className="font-medium">
            {senderName || (message.sender_role === 'admin' ? '管理者' : 'ドライバー')}
          </span>
          <span>·</span>
          <span>{time}</span>
          {message.message_kind === 'instruction' && (
            <span className="ml-1 px-1 bg-amber-200 text-amber-800 rounded text-[9px]">
              指示
            </span>
          )}
          {message.message_kind === 'confirmation' && (
            <span className="ml-1 px-1 bg-emerald-200 text-emerald-800 rounded text-[9px]">
              確認済み
            </span>
          )}
          {message.message_kind === 'arrival' && (
            <span className="ml-1 px-1 bg-blue-200 text-blue-800 rounded text-[9px]">
              到着
            </span>
          )}
        </div>

        {/* instruction 本体 */}
        {message.message_kind === 'instruction' ? (
          <div className="space-y-1">
            {vehicleName && (
              <div className="flex items-center gap-1">
                <Car className="h-3 w-3" />
                <span>{vehicleName}</span>
              </div>
            )}
            {pointName && (
              <div className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                <span>{pointName}</span>
              </div>
            )}
            {message.body && (
              <div className="text-slate-700 whitespace-pre-wrap">{message.body}</div>
            )}
            {confirmed && (
              <div className="text-[10px] text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                確認済み
              </div>
            )}
            {arrived && (
              <div className="text-[10px] text-blue-700 flex items-center gap-1">
                <Flag className="h-3 w-3" />
                到着完了
              </div>
            )}

            {/* driver 側の確認ボタン */}
            {showDriverConfirm && !confirmed && !arrived && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => onConfirm(message.id)}
                  disabled={busyInstructionId === message.id}
                  className="w-full py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {busyInstructionId === message.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                  確認して開始
                </button>
              </div>
            )}

            {/* driver 側の到着ボタン (100m以内で有効) */}
            {showDriverConfirm && confirmed && !arrived && activeAssignmentId && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => onArrival(message.id)}
                  disabled={
                    busyInstructionId === message.id || !withinArrivalRange
                  }
                  className="w-full py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {busyInstructionId === message.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Flag className="h-3 w-3" />
                  )}
                  到着報告
                  {distanceM != null && (
                    <span className="text-[10px] opacity-80">
                      ({Math.round(distanceM)}m)
                    </span>
                  )}
                </button>
                {!withinArrivalRange && distanceM != null && (
                  <div className="text-[10px] text-slate-500 text-center mt-0.5">
                    目的地まで {Math.round(distanceM)}m (100m 以内で押せます)
                  </div>
                )}
              </div>
            )}
          </div>
        ) : message.message_kind === 'note' ? (
          <div className="whitespace-pre-wrap">{message.body}</div>
        ) : (
          <div className="text-slate-600 italic">
            {message.message_kind === 'confirmation' && (
              <>
                <MessageSquare className="h-3 w-3 inline mr-1" />
                指示を確認して開始しました
              </>
            )}
            {message.message_kind === 'arrival' && (
              <>
                <Flag className="h-3 w-3 inline mr-1" />
                到着しました
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
