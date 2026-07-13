// /admin/users: ユーザー管理。
//   - サイトオーナー: 全ユーザー一覧 + フルネーム・所属組織の編集 (従来通り)
//   - 組織管理者 (organization_members.role='admin'): 自組織のメンバー管理ビューへ切替
//
// サイトオーナー用データソース:
//   - 一覧: admin_list_users RPC（SECURITY DEFINER で auth.users と JOIN）
//   - 更新: admin_upsert_profile RPC
//   - 組織一覧: organizations テーブル（SELECT は全認証ユーザー可）
//
// 組織管理者判定:
//   - list_my_admin_org_ids RPC で「自分が admin である組織」を取得
//   - 1 個以上あればアクセス許可、UI は OrgMembersView に切替
//   - 複数組織を管理していれば組織セレクタで切替 (通常は 1 個の想定)

import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Loader2, RefreshCw, ArrowLeft, Users, Save, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { AdminUserRow, Organization } from '@/types/database'
import { OrgMembersView } from './OrgMembersView'

interface AdminOrgRow {
  organization_id: string
  organization_name: string
}

interface RowDraft {
  full_name: string
  organization_id: string | ''
  dirty: boolean
  saving: boolean
  error: string | null
}

// 削除処理中の user_id の集合 (行内スピナー用)
type DeletingSet = Set<string>

export function AdminUsersPage() {
  const { user } = useAuth()
  const siteOwner = isAdmin(user?.email)
  const [myAdminOrgs, setMyAdminOrgs] = useState<AdminOrgRow[] | null>(null)
  // 「複数組織を admin する」場合の切替 (通常 1 個)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)

  // 組織 admin 判定
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = (await supabase.rpc(
          'list_my_admin_org_ids' as never,
        )) as unknown as {
          data: AdminOrgRow[] | null
          error: { message: string } | null
        }
        if (error) throw error
        if (cancelled) return
        const list = (data ?? []) as AdminOrgRow[]
        setMyAdminOrgs(list)
        if (list.length > 0) setActiveOrgId(list[0].organization_id)
      } catch {
        if (!cancelled) setMyAdminOrgs([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  const [rows, setRows] = useState<AdminUserRow[]>([])
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [drafts, setDrafts] = useState<Map<string, RowDraft>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [deleting, setDeleting] = useState<DeletingSet>(new Set())

  const fetchAll = useCallback(async () => {
    // サイトオーナーでない場合は admin_list_users を叩かない (RPC が
    // 'Not authorized' で失敗する)。組織 admin ビューは OrgMembersView に委譲。
    if (!siteOwner) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // admin_list_users は database.ts に未登録 RPC のため、型アサーションで呼ぶ。
      // supabase.rpc は this 必須なので、変数に代入せず、必ず supabase.rpc(...) の形で呼ぶ。
      const [usersRes, orgsRes] = await Promise.all([
        (
          supabase.rpc as unknown as (
            fn: string,
          ) => Promise<{
            data: AdminUserRow[] | null
            error: { message: string } | null
          }>
        )('admin_list_users'),
        supabase.from('organizations').select('*').order('name'),
      ])
      if (usersRes.error) throw usersRes.error
      if (orgsRes.error) throw orgsRes.error
      const userRows = (usersRes.data ?? []) as AdminUserRow[]
      setRows(userRows)
      setOrgs((orgsRes.data ?? []) as Organization[])
      // ドラフトを初期化
      const m = new Map<string, RowDraft>()
      for (const r of userRows) {
        m.set(r.user_id, {
          full_name: r.full_name ?? '',
          organization_id: r.organization_id ?? '',
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
  }, [siteOwner])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const updateDraft = (userId: string, patch: Partial<RowDraft>) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      const cur = next.get(userId) ?? {
        full_name: '',
        organization_id: '',
        dirty: false,
        saving: false,
        error: null,
      }
      next.set(userId, { ...cur, ...patch, dirty: true })
      return next
    })
  }

  const handleSave = async (userId: string) => {
    const d = drafts.get(userId)
    if (!d) return
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(userId, { ...d, saving: true, error: null })
      return next
    })
    try {
      const { error: rpcError } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>
      )('admin_upsert_profile', {
        p_user_id: userId,
        p_full_name: d.full_name.trim() || null,
        p_organization_id: d.organization_id || null,
      })
      if (rpcError) throw rpcError
      // 一覧側にも反映
      setRows((prev) =>
        prev.map((r) =>
          r.user_id === userId
            ? {
                ...r,
                full_name: d.full_name.trim() || null,
                organization_id: d.organization_id || null,
                organization_name:
                  orgs.find((o) => o.id === d.organization_id)?.name ?? null,
              }
            : r,
        ),
      )
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(userId, { ...d, dirty: false, saving: false, error: null })
        return next
      })
    } catch (err) {
      setDrafts((prev) => {
        const next = new Map(prev)
        next.set(userId, {
          ...d,
          saving: false,
          error: err instanceof Error ? err.message : '保存に失敗しました',
        })
        return next
      })
    }
  }

  const handleDelete = async (row: AdminUserRow) => {
    if (row.user_id === user?.id) {
      alert('自分自身は削除できません')
      return
    }
    const label = row.full_name ? `${row.full_name} (${row.email})` : row.email
    if (
      !confirm(
        `ユーザー「${label}」をアカウントごと完全削除します。\n\n` +
          '・ログイン不可になります\n' +
          '・プロフィール / 組織所属 / 共有メンバー登録 も自動的に消えます\n' +
          '・工事 (現場) を 1 件でも所有していると削除できません\n\n' +
          'この操作は元に戻せません。よろしいですか?',
      )
    ) {
      return
    }
    setDeleting((prev) => {
      const next = new Set(prev)
      next.add(row.user_id)
      return next
    })
    setError(null)
    try {
      const { data, error: invErr } = await supabase.functions.invoke(
        'admin-delete-user',
        { body: { user_id: row.user_id } },
      )
      if (invErr) throw invErr
      const result = data as { ok?: boolean; error?: string }
      if (!result?.ok) {
        throw new Error(result?.error ?? '削除に失敗しました')
      }
      setRows((prev) => prev.filter((r) => r.user_id !== row.user_id))
      setDrafts((prev) => {
        const next = new Map(prev)
        next.delete(row.user_id)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev)
        next.delete(row.user_id)
        return next
      })
    }
  }

  // アクセス制御:
  //   - サイトオーナー: 通常のフル一覧ビュー
  //   - 組織 admin (list_my_admin_org_ids > 0): 自組織のメンバービュー
  //   - どちらでもない: トップへリダイレクト
  //   myAdminOrgs はまだ null (取得中) の間は待機
  if (!siteOwner) {
    if (myAdminOrgs === null) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
        </div>
      )
    }
    if (myAdminOrgs.length === 0) {
      return <Navigate to="/" replace />
    }
    // 組織管理者向けビュー
    const activeOrg =
      myAdminOrgs.find((o) => o.organization_id === activeOrgId) ??
      myAdminOrgs[0]
    return (
      <div className="h-screen flex flex-col bg-slate-50">
        <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
          <Link
            to="/"
            className="p-1.5 hover:bg-slate-100 rounded"
            title="トップへ"
          >
            <ArrowLeft className="h-4 w-4 text-slate-600" />
          </Link>
          <Users className="h-5 w-5 text-blue-600" />
          <h1 className="text-lg font-bold flex-1">メンバー管理</h1>
          {myAdminOrgs.length > 1 && (
            <select
              value={activeOrg.organization_id}
              onChange={(e) => setActiveOrgId(e.target.value)}
              className="px-2 py-1 text-sm border rounded bg-white"
            >
              {myAdminOrgs.map((o) => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.organization_name}
                </option>
              ))}
            </select>
          )}
        </header>
        <OrgMembersView
          key={activeOrg.organization_id}
          organizationId={activeOrg.organization_id}
          organizationName={activeOrg.organization_name}
        />
      </div>
    )
  }

  const filtered = filter
    ? rows.filter(
        (r) =>
          r.email.toLowerCase().includes(filter.toLowerCase()) ||
          (r.full_name ?? '').toLowerCase().includes(filter.toLowerCase()) ||
          (r.organization_name ?? '').toLowerCase().includes(filter.toLowerCase()),
      )
    : rows

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link to="/" className="p-1.5 hover:bg-slate-100 rounded" title="トップへ">
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <Users className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">ユーザー管理</h1>
        <Link
          to="/admin/organizations"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          組織管理
        </Link>
        <Link
          to="/admin/signups"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          申込管理
        </Link>
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

      <div className="px-4 py-2 bg-white border-b">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="メール / 氏名 / 組織名で絞り込み"
          className="w-full px-3 py-1.5 text-sm border rounded"
        />
      </div>

      <div className="flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            該当するユーザーがいません
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
              <tr>
                <th className="text-left px-3 py-2">メール</th>
                <th className="text-left px-3 py-2 w-44">フルネーム</th>
                <th className="text-left px-3 py-2 w-44">所属組織</th>
                <th className="text-left px-3 py-2 w-36">最終ログイン</th>
                <th className="text-left px-3 py-2 w-32">登録日</th>
                <th className="text-left px-3 py-2 w-36"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const d = drafts.get(r.user_id)
                if (!d) return null
                return (
                  <tr key={r.user_id} className="border-b hover:bg-slate-50/50">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium break-all">{r.email}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{r.user_id}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={d.full_name}
                        onChange={(e) =>
                          updateDraft(r.user_id, { full_name: e.target.value })
                        }
                        placeholder="（未設定）"
                        className="w-full px-2 py-1 text-sm border rounded"
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        value={d.organization_id}
                        onChange={(e) =>
                          updateDraft(r.user_id, { organization_id: e.target.value })
                        }
                        className="w-full px-2 py-1 text-sm border rounded bg-white"
                      >
                        <option value="">（無所属）</option>
                        {orgs.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-slate-500">
                      {r.last_sign_in_at
                        ? new Date(r.last_sign_in_at).toLocaleString('ja-JP')
                        : '-'}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-slate-500">
                      {new Date(r.created_at).toLocaleString('ja-JP')}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleSave(r.user_id)}
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
                        {r.user_id !== user?.id && (
                          <button
                            onClick={() => handleDelete(r)}
                            disabled={deleting.has(r.user_id)}
                            className="p-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                            title="このユーザーをアカウントごと削除"
                          >
                            {deleting.has(r.user_id) ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
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
