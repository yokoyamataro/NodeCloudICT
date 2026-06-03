// サイトオーナー用: 組織（会社）マスタの一覧 / 追加 / 名称・メモ編集 / 削除。
// /admin/organizations（要ログイン + サイトオーナー判定）。
//
// RLS:
//   SELECT は全認証ユーザー可、INSERT/UPDATE/DELETE は is_site_owner() のみ。

import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  Loader2,
  RefreshCw,
  ArrowLeft,
  Building2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { Organization } from '@/types/database'

interface Draft {
  name: string
  note: string
  dirty: boolean
  saving: boolean
  error: string | null
}

export function AdminOrganizationsPage() {
  const { user } = useAuth()
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 新規追加フォーム
  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNote, setNewNote] = useState('')
  const [creating, setCreating] = useState(false)

  const fetchOrgs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('organizations')
        .select('*')
        .order('name')
      if (e) throw e
      const rows = (data ?? []) as Organization[]
      setOrgs(rows)
      const m = new Map<string, Draft>()
      for (const o of rows) {
        m.set(o.id, {
          name: o.name,
          note: o.note ?? '',
          dirty: false,
          saving: false,
          error: null,
        })
      }
      setDrafts(m)
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOrgs()
  }, [fetchOrgs])

  const updateDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      const cur = next.get(id) ?? {
        name: '',
        note: '',
        dirty: false,
        saving: false,
        error: null,
      }
      next.set(id, { ...cur, ...patch, dirty: true })
      return next
    })
  }

  const handleSave = async (id: string) => {
    const d = drafts.get(id)
    if (!d) return
    if (!d.name.trim()) {
      updateDraft(id, { error: '名称は必須です' })
      return
    }
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(id, { ...d, saving: true, error: null })
      return next
    })
    try {
      const { error: e } = await supabase
        .from('organizations')
        .update({ name: d.name.trim(), note: d.note.trim() || null } as never)
        .eq('id', id)
      if (e) throw e
      setOrgs((prev) =>
        prev.map((o) =>
          o.id === id ? { ...o, name: d.name.trim(), note: d.note.trim() || null } : o,
        ),
      )
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(id, { ...d, dirty: false, saving: false, error: null })
        return next
      })
    } catch (err) {
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(id, {
          ...d,
          saving: false,
          error: err instanceof Error ? err.message : '保存に失敗しました',
        })
        return next
      })
    }
  }

  const handleDelete = async (id: string) => {
    const o = orgs.find((x) => x.id === id)
    if (!o) return
    if (
      !confirm(
        `「${o.name}」を削除しますか？\n\n所属していたユーザーは「無所属」になります。`,
      )
    ) {
      return
    }
    try {
      const { error: e } = await supabase.from('organizations').delete().eq('id', id)
      if (e) throw e
      setOrgs((prev) => prev.filter((x) => x.id !== id))
      setDrafts((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const { data, error: e } = await supabase
        .from('organizations')
        .insert({ name, note: newNote.trim() || null } as never)
        .select()
        .single()
      if (e) throw e
      const created = data as Organization
      setOrgs((prev) => [created, ...prev].sort((a, b) => a.name.localeCompare(b.name)))
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(created.id, {
          name: created.name,
          note: created.note ?? '',
          dirty: false,
          saving: false,
          error: null,
        })
        return next
      })
      setNewName('')
      setNewNote('')
      setShowNewForm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '作成に失敗しました')
    } finally {
      setCreating(false)
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
        <Building2 className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">組織管理</h1>
        <Link
          to="/admin/users"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          ユーザー管理
        </Link>
        <Link
          to="/admin/signups"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          申込管理
        </Link>
        <button
          onClick={() => setShowNewForm((s) => !s)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" />
          新規組織
        </button>
        <button
          onClick={fetchOrgs}
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

      {showNewForm && (
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-200">
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              <label className="block text-xs text-slate-600 mb-1">組織名（必須・重複不可）</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                className="w-full px-2 py-1.5 text-sm border rounded"
              />
            </div>
            <div className="col-span-6">
              <label className="block text-xs text-slate-600 mb-1">メモ（任意）</label>
              <input
                type="text"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded"
              />
            </div>
            <div className="col-span-2 flex gap-1">
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                作成
              </button>
              <button
                onClick={() => {
                  setShowNewForm(false)
                  setNewName('')
                  setNewNote('')
                }}
                className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"
                title="閉じる"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && orgs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : orgs.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            組織がまだありません。右上の「新規組織」から追加してください。
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 w-64">組織名</th>
                <th className="text-left px-3 py-2">メモ</th>
                <th className="text-left px-3 py-2 w-40">登録日</th>
                <th className="text-left px-3 py-2 w-32"></th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const d = drafts.get(o.id)
                if (!d) return null
                return (
                  <tr key={o.id} className="border-b hover:bg-slate-50/50">
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={d.name}
                        onChange={(e) => updateDraft(o.id, { name: e.target.value })}
                        className="w-full px-2 py-1 text-sm border rounded font-medium"
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={d.note}
                        onChange={(e) => updateDraft(o.id, { note: e.target.value })}
                        placeholder="（メモなし）"
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-slate-500">
                      {new Date(o.created_at).toLocaleDateString('ja-JP')}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleSave(o.id)}
                          disabled={!d.dirty || d.saving}
                          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
                            d.dirty
                              ? 'bg-blue-600 text-white hover:bg-blue-700'
                              : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                          } disabled:opacity-50`}
                        >
                          {d.saving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                          保存
                        </button>
                        <button
                          onClick={() => handleDelete(o.id)}
                          className="p-1 text-red-600 hover:bg-red-50 rounded"
                          title="削除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {d.error && (
                        <div className="mt-1 text-[10px] text-red-600">{d.error}</div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
