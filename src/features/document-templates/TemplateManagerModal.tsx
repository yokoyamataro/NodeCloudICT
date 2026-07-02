// Word テンプレート管理モーダル。
// アップロード / 名前変更 / 削除 / 共有先ユーザー編集ができる。

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  Share2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { DocumentTemplate } from '@/types/database'
import { useAuth } from '@/contexts/AuthContext'
import { useDocumentTemplateStore } from '@/stores/documentTemplateStore'
import { AVAILABLE_PLACEHOLDERS } from '@/lib/documents/templateRender'

interface Props {
  onClose: () => void
}

export function TemplateManagerModal({ onClose }: Props) {
  const { user } = useAuth()
  const {
    templates,
    sharesByTemplateId,
    shareCandidates,
    loading,
    error,
    fetchAll,
    fetchShareCandidates,
    fetchShares,
    uploadTemplate,
    updateTemplate,
    deleteTemplate,
    setShares,
    downloadTemplateBlob,
  } = useDocumentTemplateStore()

  const [uploadOpen, setUploadOpen] = useState(false)
  const [placeholdersOpen, setPlaceholdersOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    void fetchAll()
    void fetchShareCandidates()
  }, [fetchAll, fetchShareCandidates])

  const ownTemplates = useMemo(
    () => templates.filter((t) => t.owner_user_id === user?.id),
    [templates, user],
  )
  const sharedTemplates = useMemo(
    () => templates.filter((t) => t.owner_user_id !== user?.id),
    [templates, user],
  )

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else {
        next.add(id)
        void fetchShares(id)
      }
      return next
    })
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">Word テンプレート管理</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-2 border-b flex items-center justify-between">
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            テンプレートを追加
          </button>
          <button
            onClick={() => setPlaceholdersOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
          >
            {placeholdersOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            使えるプレースホルダ一覧
          </button>
        </div>

        {placeholdersOpen && (
          <div className="px-4 py-2 border-b bg-slate-50">
            <div className="text-[11px] text-slate-500 mb-1">
              Word テンプレート内に <code>{'{タグ名}'}</code> と書いた箇所が置き換わります
            </div>
            <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
              {AVAILABLE_PLACEHOLDERS.map((p) => (
                <li key={p.tag} className="truncate">
                  <code className="text-blue-700">{p.tag}</code>
                  <span className="text-slate-500 ml-1">{p.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          {loading && templates.length === 0 && (
            <div className="flex items-center justify-center text-slate-500 text-sm py-8">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              読み込み中…
            </div>
          )}

          <section>
            <div className="text-xs font-semibold text-slate-500 mb-1">
              自分のテンプレート ({ownTemplates.length})
            </div>
            {ownTemplates.length === 0 ? (
              <div className="text-xs text-slate-400 border rounded p-3 text-center">
                （まだありません。「テンプレートを追加」からアップロードしてください）
              </div>
            ) : (
              ownTemplates.map((t) => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  own
                  expanded={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  shares={sharesByTemplateId.get(t.id) ?? []}
                  shareCandidates={shareCandidates}
                  onRename={(name) => updateTemplate(t.id, { name })}
                  onDescribe={(description) => updateTemplate(t.id, { description })}
                  onSetShares={(userIds) => setShares(t.id, userIds)}
                  onDelete={async () => {
                    if (confirm(`「${t.name}」を削除しますか？`)) {
                      await deleteTemplate(t.id)
                    }
                  }}
                  onDownload={async () => {
                    const blob = await downloadTemplateBlob(t)
                    if (!blob) return
                    const a = document.createElement('a')
                    const url = URL.createObjectURL(blob)
                    a.href = url
                    a.download = `${t.name}.docx`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                    URL.revokeObjectURL(url)
                  }}
                />
              ))
            )}
          </section>

          {sharedTemplates.length > 0 && (
            <section>
              <div className="text-xs font-semibold text-slate-500 mb-1">
                共有されたテンプレート ({sharedTemplates.length})
              </div>
              {sharedTemplates.map((t) => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  own={false}
                  expanded={false}
                  onToggle={() => {}}
                  shares={[]}
                  shareCandidates={[]}
                  onRename={() => {}}
                  onDescribe={() => {}}
                  onSetShares={() => {}}
                  onDelete={() => {}}
                  onDownload={async () => {
                    const blob = await downloadTemplateBlob(t)
                    if (!blob) return
                    const a = document.createElement('a')
                    const url = URL.createObjectURL(blob)
                    a.href = url
                    a.download = `${t.name}.docx`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                    URL.revokeObjectURL(url)
                  }}
                />
              ))}
            </section>
          )}
        </div>

        <div className="px-4 py-3 border-t flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50">
            閉じる
          </button>
        </div>
      </div>

      {uploadOpen && (
        <UploadPanel
          onClose={() => setUploadOpen(false)}
          onUpload={async ({ name, description, file }) => {
            const t = await uploadTemplate({ name, description, file })
            if (t) setUploadOpen(false)
          }}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// 1 行分（アコーディオン）
// --------------------------------------------------------------------------
function TemplateRow({
  template,
  own,
  expanded,
  onToggle,
  shares,
  shareCandidates,
  onRename,
  onDescribe,
  onSetShares,
  onDelete,
  onDownload,
}: {
  template: DocumentTemplate
  own: boolean
  expanded: boolean
  onToggle: () => void
  shares: string[]
  shareCandidates: Array<{ user_id: string; email: string; full_name: string | null }>
  onRename: (name: string) => void
  onDescribe: (description: string | null) => void
  onSetShares: (userIds: string[]) => Promise<void> | void
  onDelete: () => void
  onDownload: () => Promise<void> | void
}) {
  const [name, setName] = useState(template.name)
  const [description, setDescription] = useState(template.description ?? '')
  const [sharesDraft, setSharesDraft] = useState<Set<string>>(new Set(shares))
  const [savingShares, setSavingShares] = useState(false)

  useEffect(() => {
    setName(template.name)
    setDescription(template.description ?? '')
  }, [template.name, template.description])
  useEffect(() => {
    setSharesDraft(new Set(shares))
  }, [shares])

  const toggleShare = (uid: string) => {
    setSharesDraft((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  const handleSaveShares = async () => {
    setSavingShares(true)
    try {
      await onSetShares(Array.from(sharesDraft))
    } finally {
      setSavingShares(false)
    }
  }

  return (
    <div className="border rounded mb-2 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        {own ? (
          <button onClick={onToggle} className="text-slate-400 hover:text-slate-600">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{template.name}</div>
          {template.description && (
            <div className="text-[11px] text-slate-500 truncate">{template.description}</div>
          )}
        </div>
        <button
          onClick={onDownload}
          className="p-1.5 text-slate-500 hover:text-blue-600 rounded"
          title="テンプレをダウンロード"
        >
          <Download className="h-4 w-4" />
        </button>
        {own && (
          <button
            onClick={onDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 rounded"
            title="削除"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {own && expanded && (
        <div className="border-t bg-slate-50 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-slate-500">テンプレート名</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name.trim() && name !== template.name) onRename(name.trim())
                }}
                className="w-full px-2 py-1 border rounded text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-slate-500">説明（任意）</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== (template.description ?? '')) {
                    onDescribe(description.trim() || null)
                  }
                }}
                className="w-full px-2 py-1 border rounded text-sm"
              />
            </label>
          </div>

          <div>
            <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-1">
              <Share2 className="h-3.5 w-3.5" />
              共有先ユーザー ({sharesDraft.size} 名)
            </div>
            {shareCandidates.length === 0 ? (
              <div className="text-[11px] text-slate-400 border rounded p-2">
                共有可能なユーザーが見つかりません。（同組織 / 子ユーザーが候補になります）
              </div>
            ) : (
              <div className="max-h-32 overflow-auto border rounded bg-white p-1">
                {shareCandidates.map((u) => {
                  const on = sharesDraft.has(u.user_id)
                  return (
                    <button
                      key={u.user_id}
                      type="button"
                      onClick={() => toggleShare(u.user_id)}
                      className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded ${
                        on ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center w-4 h-4 border rounded ${
                          on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="truncate">
                        {u.full_name ? `${u.full_name} — ` : ''}
                        {u.email}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-2 text-right">
              <button
                onClick={handleSaveShares}
                disabled={savingShares}
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {savingShares ? '保存中…' : '共有設定を保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// アップロードパネル（子モーダル）
// --------------------------------------------------------------------------
function UploadPanel({
  onClose,
  onUpload,
}: {
  onClose: () => void
  onUpload: (params: { name: string; description: string | null; file: File }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const canSubmit = !!file && name.trim().length > 0 && !busy

  const handle = async () => {
    if (!canSubmit || !file) return
    setBusy(true)
    try {
      await onUpload({ name: name.trim(), description: description.trim() || null, file })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h4 className="text-sm font-semibold">テンプレートを追加</h4>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block">
            <span className="text-xs text-slate-500">名前 *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="立入通知書 標準版"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">説明（任意）</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="境界立会のお願い（社内標準）"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Word ファイル (.docx)</span>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
            {file && (
              <div className="text-[11px] text-slate-500 mt-1">
                {file.name} ({Math.ceil(file.size / 1024)} KB)
              </div>
            )}
          </label>
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50">
            キャンセル
          </button>
          <button
            onClick={handle}
            disabled={!canSubmit}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            アップロード
          </button>
        </div>
      </div>
    </div>
  )
}
