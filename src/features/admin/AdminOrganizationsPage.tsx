// サイトオーナー用: 組織（会社）マスタの一覧 / 追加 / 編集 / 削除。
// /admin/organizations（要ログイン + サイトオーナー判定）。
//
// 管理項目:
//   組織名 / 電話番号 / 住所 / 代表者 / 管理者(ユーザー) /
//   ユーザー数 / プラン / メモ
//
// ユーザー数 / プランは現時点で他の挙動に影響を与えない管理データ。
//
// レイアウト:
//   1 組織 = 1 行の表形式。フィールドが多いので固定幅 + 横スクロール。
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
import type { Organization, AdminUserRow } from '@/types/database'

interface Draft {
  name: string
  postal_code: string
  phone: string
  address: string
  representative: string
  admin_user_id: string
  user_count_limit: string
  plan: string
  note: string
  dirty: boolean
  saving: boolean
  error: string | null
}

const EMPTY_DRAFT: Omit<Draft, 'dirty' | 'saving' | 'error'> = {
  name: '',
  postal_code: '',
  phone: '',
  address: '',
  representative: '',
  admin_user_id: '',
  user_count_limit: '',
  plan: '',
  note: '',
}

function toDraft(o: Organization): Draft {
  return {
    name: o.name,
    postal_code: o.postal_code ?? '',
    phone: o.phone ?? '',
    address: o.address ?? '',
    representative: o.representative ?? '',
    admin_user_id: o.admin_user_id ?? '',
    user_count_limit: o.user_count_limit == null ? '' : String(o.user_count_limit),
    plan: o.plan ?? '',
    note: o.note ?? '',
    dirty: false,
    saving: false,
    error: null,
  }
}

function toPayload(d: Draft): {
  name: string
  postal_code: string | null
  phone: string | null
  address: string | null
  representative: string | null
  admin_user_id: string | null
  user_count_limit: number | null
  plan: string | null
  note: string | null
} {
  let limit: number | null = null
  if (d.user_count_limit.trim() !== '') {
    const n = Number(d.user_count_limit)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error('ユーザー数は 0 以上の整数で指定してください')
    }
    limit = n
  }
  return {
    name: d.name.trim(),
    postal_code: d.postal_code.trim() || null,
    phone: d.phone.trim() || null,
    address: d.address.trim() || null,
    representative: d.representative.trim() || null,
    admin_user_id: d.admin_user_id || null,
    user_count_limit: limit,
    plan: d.plan.trim() || null,
    note: d.note.trim() || null,
  }
}

export function AdminOrganizationsPage() {
  const { user } = useAuth()
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [userOptions, setUserOptions] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 新規追加フォーム
  const [showNewForm, setShowNewForm] = useState(false)
  const [newDraft, setNewDraft] = useState<Draft>({
    ...EMPTY_DRAFT,
    dirty: false,
    saving: false,
    error: null,
  })
  const [creating, setCreating] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orgsRes, usersRes] = await Promise.all([
        supabase.from('organizations').select('*').order('name'),
        (
          supabase.rpc as unknown as (
            fn: string,
          ) => Promise<{
            data: AdminUserRow[] | null
            error: { message: string } | null
          }>
        )('admin_list_users'),
      ])
      if (orgsRes.error) throw orgsRes.error
      if (usersRes.error) throw usersRes.error
      const rows = (orgsRes.data ?? []) as Organization[]
      setOrgs(rows)
      setUserOptions((usersRes.data ?? []) as AdminUserRow[])
      const m = new Map<string, Draft>()
      for (const o of rows) {
        m.set(o.id, toDraft(o))
      }
      setDrafts(m)
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const updateDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      const cur = next.get(id)
      if (!cur) return prev
      next.set(id, { ...cur, ...patch, dirty: true })
      return next
    })
  }

  const handleSave = async (id: string) => {
    const d = drafts.get(id)
    if (!d) return
    if (!d.name.trim()) {
      updateDraft(id, { error: '組織名は必須です' })
      return
    }
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(id, { ...d, saving: true, error: null })
      return next
    })
    try {
      const payload = toPayload(d)
      const { error: e } = await supabase
        .from('organizations')
        .update(payload as never)
        .eq('id', id)
      if (e) throw e
      setOrgs((prev) =>
        prev.map((o) => (o.id === id ? { ...o, ...payload } : o)),
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
    if (!newDraft.name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const payload = toPayload(newDraft)
      const { data, error: e } = await supabase
        .from('organizations')
        .insert(payload as never)
        .select()
        .single()
      if (e) throw e
      const created = data as Organization
      setOrgs((prev) =>
        [created, ...prev].sort((a, b) => a.name.localeCompare(b.name)),
      )
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(created.id, toDraft(created))
        return next
      })
      setNewDraft({ ...EMPTY_DRAFT, dirty: false, saving: false, error: null })
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
          onClick={fetchAll}
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
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-200 overflow-x-auto">
          <div className="text-xs font-semibold text-slate-700 mb-2">新規組織</div>
          <NewOrgRow
            draft={newDraft}
            onChange={(patch) =>
              setNewDraft((prev) => ({ ...prev, ...patch, dirty: true }))
            }
            onCancel={() => {
              setShowNewForm(false)
              setNewDraft({
                ...EMPTY_DRAFT,
                dirty: false,
                saving: false,
                error: null,
              })
            }}
            onCreate={handleCreate}
            creating={creating}
          />
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
          <table className="text-sm border-separate border-spacing-0 min-w-max">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0 z-10">
              <tr>
                <Th w="w-52">組織名 *</Th>
                <Th w="w-32">代表者</Th>
                <Th w="w-36">電話番号</Th>
                <Th w="w-28">郵便番号</Th>
                <Th w="w-64">住所</Th>
                <Th w="w-52">管理者</Th>
                <Th w="w-56">所属メンバー</Th>
                <Th w="w-28">プラン</Th>
                <Th w="w-20">ユーザー数</Th>
                <Th w="w-52">メモ</Th>
                <Th w="w-28">登録日</Th>
                <Th w="w-28">操作</Th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const d = drafts.get(o.id)
                if (!d) return null
                return (
                  <tr key={o.id} className="border-b hover:bg-slate-50/50">
                    <Td>
                      <input
                        type="text"
                        value={d.name}
                        onChange={(e) => updateDraft(o.id, { name: e.target.value })}
                        className="w-full px-2 py-1 text-sm border rounded font-medium"
                      />
                    </Td>
                    <Td>
                      <input
                        type="text"
                        value={d.representative}
                        onChange={(e) =>
                          updateDraft(o.id, { representative: e.target.value })
                        }
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <input
                        type="tel"
                        value={d.phone}
                        onChange={(e) => updateDraft(o.id, { phone: e.target.value })}
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <input
                        type="text"
                        value={d.postal_code}
                        onChange={(e) =>
                          updateDraft(o.id, { postal_code: e.target.value })
                        }
                        placeholder="例: 999-0000"
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <input
                        type="text"
                        value={d.address}
                        onChange={(e) => updateDraft(o.id, { address: e.target.value })}
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <AdminSelect
                        value={d.admin_user_id}
                        onChange={(v) => updateDraft(o.id, { admin_user_id: v })}
                        members={userOptions.filter(
                          (u) => u.organization_id === o.id,
                        )}
                      />
                    </Td>
                    <Td>
                      <MemberList
                        members={userOptions.filter(
                          (u) =>
                            u.organization_id === o.id &&
                            u.user_id !== d.admin_user_id,
                        )}
                      />
                    </Td>
                    <Td>
                      <input
                        type="text"
                        value={d.plan}
                        onChange={(e) => updateDraft(o.id, { plan: e.target.value })}
                        placeholder="任意"
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <input
                        type="number"
                        min={0}
                        value={d.user_count_limit}
                        onChange={(e) =>
                          updateDraft(o.id, { user_count_limit: e.target.value })
                        }
                        placeholder="任意"
                        className="w-full px-2 py-1 text-sm border rounded text-right"
                      />
                    </Td>
                    <Td>
                      <input
                        type="text"
                        value={d.note}
                        onChange={(e) => updateDraft(o.id, { note: e.target.value })}
                        placeholder="（メモなし）"
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </Td>
                    <Td>
                      <div className="text-xs text-slate-500">
                        {new Date(o.created_at).toLocaleDateString('ja-JP')}
                      </div>
                    </Td>
                    <Td>
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
                    </Td>
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

function Th({ children, w }: { children: React.ReactNode; w?: string }) {
  return (
    <th className={`text-left px-2 py-2 border-b bg-slate-100 ${w ?? ''}`}>{children}</th>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-1.5 align-top">{children}</td>
}

// 組織の所属メンバー (管理者を除いた残り) を chip 状に一覧表示する。
function MemberList({ members }: { members: AdminUserRow[] }) {
  if (members.length === 0) {
    return (
      <span className="text-[11px] text-slate-400">（他のメンバーなし）</span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {members.map((u) => (
        <span
          key={u.user_id}
          className="inline-block px-1.5 py-0.5 text-[11px] rounded bg-slate-100 border border-slate-200 text-slate-700"
          title={u.email}
        >
          {u.full_name || u.email}
        </span>
      ))}
    </div>
  )
}

// 管理者プルダウン。選択肢は「その組織に所属するユーザー」に限定される。
// members が空の時は「所属メンバーがいません」を表示して選択を促さない。
// 現在設定されている admin_user_id が members に含まれない場合 (先に profile の
// organization_id が変わった等) は「(所属外)」を頭に付けて表示するだけに留める。
function AdminSelect({
  value,
  onChange,
  members,
}: {
  value: string
  onChange: (v: string) => void
  members: AdminUserRow[]
}) {
  const currentInList = members.some((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 text-sm border rounded bg-white"
    >
      <option value="">（未設定）</option>
      {!currentInList && value && (
        <option value={value}>（所属外のユーザー）</option>
      )}
      {members.length === 0 ? (
        <option value="" disabled>
          — この組織の所属メンバーがいません —
        </option>
      ) : (
        members.map((u) => (
          <option key={u.user_id} value={u.user_id}>
            {u.full_name ? `${u.full_name} (${u.email})` : u.email}
          </option>
        ))
      )}
    </select>
  )
}

function NewOrgRow({
  draft,
  onChange,
  onCancel,
  onCreate,
  creating,
}: {
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
  onCancel: () => void
  onCreate: () => void
  creating: boolean
}) {
  return (
    <div className="min-w-max flex items-start gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-x-3 gap-y-1.5 flex-1">
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">組織名 *</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            autoFocus
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">代表者</span>
          <input
            type="text"
            value={draft.representative}
            onChange={(e) => onChange({ representative: e.target.value })}
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">電話番号</span>
          <input
            type="tel"
            value={draft.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">郵便番号</span>
          <input
            type="text"
            value={draft.postal_code}
            onChange={(e) => onChange({ postal_code: e.target.value })}
            placeholder="例: 999-0000"
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">住所</span>
          <input
            type="text"
            value={draft.address}
            onChange={(e) => onChange({ address: e.target.value })}
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">管理者</span>
          <select
            disabled
            className="w-full px-2 py-1 border rounded bg-slate-100 text-slate-400"
            title="組織を作成後、所属メンバーの中から選択できます"
          >
            <option>（作成後に選択）</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">プラン</span>
          <input
            type="text"
            value={draft.plan}
            onChange={(e) => onChange({ plan: e.target.value })}
            placeholder="任意"
            className="w-full px-2 py-1 border rounded"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">ユーザー数</span>
          <input
            type="number"
            min={0}
            value={draft.user_count_limit}
            onChange={(e) => onChange({ user_count_limit: e.target.value })}
            placeholder="任意"
            className="w-full px-2 py-1 border rounded text-right"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-600 mb-0.5">メモ</span>
          <input
            type="text"
            value={draft.note}
            onChange={(e) => onChange({ note: e.target.value })}
            className="w-full px-2 py-1 border rounded"
          />
        </label>
      </div>
      <div className="shrink-0 flex flex-col gap-1 mt-4">
        <button
          onClick={onCreate}
          disabled={creating || !draft.name.trim()}
          className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          作成
        </button>
        <button
          onClick={onCancel}
          className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          <X className="h-3.5 w-3.5" />
          閉じる
        </button>
      </div>
    </div>
  )
}
