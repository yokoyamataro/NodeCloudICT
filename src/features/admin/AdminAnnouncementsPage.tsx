// サイトオーナー用: お知らせ (announcements) の作成・編集・削除画面。
// /admin/announcements（要ログイン + サイトオーナー判定）。

import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowLeft,
  Bell,
  Loader2,
  RefreshCw,
  Plus,
  Save,
  Trash2,
  X,
  Pencil,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { Announcement } from '@/types/database'

interface DraftFields {
  title: string
  body: string
  /** YYYY-MM-DDTHH:mm 形式（datetime-local 入力値）。空なら今を使う */
  publishedLocal: string
}

const EMPTY_DRAFT: DraftFields = { title: '', body: '', publishedLocal: '' }

function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(s: string): string | null {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function AdminAnnouncementsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('announcements')
        .select('*')
        .order('published_at', { ascending: false })
      if (e) throw e
      setRows((data ?? []) as Announcement[])
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  const openNew = () => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setShowForm(true)
  }

  const openEdit = (row: Announcement) => {
    setEditingId(row.id)
    setDraft({
      title: row.title,
      body: row.body,
      publishedLocal: toLocalInput(row.published_at),
    })
    setFormError(null)
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setDraft(EMPTY_DRAFT)
    setEditingId(null)
    setFormError(null)
  }

  const handleSave = async () => {
    setFormError(null)
    if (!draft.title.trim()) {
      setFormError('タイトルを入力してください')
      return
    }
    if (!draft.body.trim()) {
      setFormError('本文を入力してください')
      return
    }
    setSaving(true)
    try {
      const publishedAt =
        fromLocalInput(draft.publishedLocal) ?? new Date().toISOString()
      if (editingId) {
        const { error: e } = await supabase
          .from('announcements')
          .update({
            title: draft.title.trim(),
            body: draft.body.trim(),
            published_at: publishedAt,
          } as never)
          .eq('id', editingId)
        if (e) throw e
      } else {
        const { error: e } = await supabase
          .from('announcements')
          .insert({
            title: draft.title.trim(),
            body: draft.body.trim(),
            published_at: publishedAt,
            created_by: user?.id ?? null,
          } as never)
        if (e) throw e
      }
      closeForm()
      await fetchRows()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row: Announcement) => {
    if (!confirm(`「${row.title}」を削除しますか？\n既読の履歴も同時に削除されます。`)) {
      return
    }
    try {
      const { error: e } = await supabase
        .from('announcements')
        .delete()
        .eq('id', row.id)
      if (e) throw e
      await fetchRows()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }

  if (!isAdmin(user?.email)) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link to="/" className="p-1.5 hover:bg-slate-100 rounded" title="トップへ">
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <Bell className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">お知らせ管理</h1>
        <button
          onClick={openNew}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" />
          新規お知らせ
        </button>
        <button
          onClick={fetchRows}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          再取得
        </button>
      </header>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            お知らせがまだありません。「新規お知らせ」から追加してください。
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="bg-white border rounded-lg p-4">
              <div className="flex items-baseline gap-2 mb-1">
                <h3 className="text-base font-semibold flex-1">{row.title}</h3>
                <span className="text-xs text-slate-500">
                  {new Date(row.published_at).toLocaleString('ja-JP')}
                </span>
                <button
                  onClick={() => openEdit(row)}
                  className="p-1 text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded"
                  title="編集"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(row)}
                  className="p-1 text-red-500 hover:bg-red-50 rounded"
                  title="削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-sm text-slate-700 whitespace-pre-wrap">
                {row.body}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 作成 / 編集モーダル */}
      {showForm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
          onClick={closeForm}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-600" />
              <h3 className="flex-1 text-base font-semibold">
                {editingId ? 'お知らせを編集' : '新規お知らせ'}
              </h3>
              <button
                onClick={closeForm}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3">
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">タイトル</span>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">本文</span>
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={10}
                  placeholder="改行は本文上でも改行として表示されます。"
                  className="w-full px-2 py-1.5 text-sm border rounded resize-y"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">
                  公開日時（空欄で「今」になります）
                </span>
                <input
                  type="datetime-local"
                  value={draft.publishedLocal}
                  onChange={(e) => setDraft({ ...draft, publishedLocal: e.target.value })}
                  className="px-2 py-1.5 text-sm border rounded"
                />
              </label>
              {formError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {formError}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <button
                onClick={closeForm}
                disabled={saving}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !draft.title.trim() || !draft.body.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {editingId ? '保存' : '公開'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
