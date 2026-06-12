// 写真サムネ + 撮影日/備考 のメタ情報をその場で編集できるタイル。
// PC モーダル (CoordinatePhotoModal) と PC 地図下パネル (CoordinatePhotoPanel) の双方で使う。

import { useEffect, useState } from 'react'
import { Loader2, Pencil, Replace, Trash2, Check, X } from 'lucide-react'
import type { Attachment } from '@/stores/attachmentStore'

function toDateInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

function parseDateInputValue(s: string): Date | null {
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  return Number.isNaN(d.getTime()) ? null : d
}

export function PhotoTileWithMeta({
  attachment,
  getSignedUrl,
  onDelete,
  onReplace,
  onUpdate,
}: {
  attachment: Attachment
  getSignedUrl: (path: string) => Promise<string | null>
  onDelete: () => void
  onReplace?: () => void
  /** 撮影日・備考の更新（attachmentStore.updateAttachment を呼ぶ想定） */
  onUpdate: (patch: { takenAt: Date | null; caption: string | null }) => void | Promise<void>
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [takenAtStr, setTakenAtStr] = useState('')
  const [caption, setCaption] = useState('')

  useEffect(() => {
    let cancelled = false
    getSignedUrl(attachment.filePath).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.filePath, getSignedUrl])

  const startEdit = () => {
    setTakenAtStr(toDateInputValue(attachment.takenAt))
    setCaption(attachment.caption ?? '')
    setEditing(true)
  }

  const commit = async () => {
    await onUpdate({
      takenAt: parseDateInputValue(takenAtStr),
      caption: caption.trim() ? caption.trim() : null,
    })
    setEditing(false)
  }

  return (
    <div className="space-y-1">
      <div className="relative">
        <a href={url ?? '#'} target="_blank" rel="noreferrer">
          {url ? (
            <img
              src={url}
              alt={attachment.caption ?? attachment.category ?? ''}
              className="w-full aspect-square object-cover rounded border"
            />
          ) : (
            <div className="w-full aspect-square bg-slate-100 rounded border flex items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            </div>
          )}
        </a>
        <div className="absolute top-1 right-1 flex gap-1">
          {onReplace && (
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onReplace()
              }}
              className="p-1.5 bg-white/95 text-blue-600 rounded shadow hover:bg-white active:bg-blue-50"
              title="差し替え"
            >
              <Replace className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onDelete()
            }}
            className="p-1.5 bg-white/95 text-red-600 rounded shadow hover:bg-white active:bg-red-50"
            title="削除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-1 rounded border bg-slate-50 p-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-600 w-10 shrink-0">撮影日</span>
            <input
              type="date"
              value={takenAtStr}
              onChange={(e) => setTakenAtStr(e.target.value)}
              className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border rounded bg-white"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-600 w-10 shrink-0">備考</span>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="(任意)"
              className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border rounded bg-white"
            />
          </div>
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setEditing(false)}
              className="p-1 text-slate-500 hover:bg-slate-200 rounded"
              title="キャンセル"
            >
              <X className="h-3 w-3" />
            </button>
            <button
              onClick={commit}
              className="p-1 text-white bg-blue-600 hover:bg-blue-700 rounded"
              title="保存"
            >
              <Check className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-slate-600 leading-tight flex items-start gap-1">
          <div className="flex-1 min-w-0">
            <div className="truncate">
              <span className="text-slate-400">撮影:</span> {fmtDateOnly(attachment.takenAt)}
            </div>
            <div className="truncate">
              <span className="text-slate-400">備考:</span>{' '}
              {attachment.caption ? attachment.caption : <span className="text-slate-400">—</span>}
            </div>
          </div>
          <button
            onClick={startEdit}
            className="shrink-0 p-1 text-slate-500 hover:bg-slate-100 rounded"
            title="撮影日・備考を編集"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}
