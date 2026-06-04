// 管理者ユーザーが自分の子ユーザーを管理するページ。
// /team（要ログイン。子ユーザーで開いた場合は「あなたは子ユーザーなのでこの
// 画面は使えません」を表示する）。
//
// 機能:
//   ・自分のサマリ（プラン / 子ユーザー数 / 上限）
//   ・子ユーザー一覧
//   ・追加: email / 氏名 / パスワード を入力して admin-create-child-user を呼ぶ
//   ・削除: admin-delete-child-user を呼ぶ
//
// プラン・上限・組織は本人からは編集できない（サイトオーナーが
// /admin/users から設定）。

import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  Loader2, RefreshCw, ArrowLeft, Users, UserPlus, Trash2, X, Save,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { AdminSummary, ChildUserRow, AccountPlan } from '@/types/database'

const PLAN_LABEL: Record<AccountPlan, string> = {
  cadastral: '地籍測量',
  civil: '土木工事',
  total: 'トータル',
}

export function TeamPage() {
  const { user } = useAuth()
  const [summary, setSummary] = useState<AdminSummary | null>(null)
  const [children, setChildren] = useState<ChildUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 追加フォーム
  const [showAddForm, setShowAddForm] = useState(false)
  const [addEmail, setAddEmail] = useState('')
  const [addFullName, setAddFullName] = useState('')
  const [addPassword, setAddPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sumRes, listRes] = await Promise.all([
        (
          supabase.rpc as unknown as (
            fn: string,
          ) => Promise<{
            data: AdminSummary[] | null
            error: { message: string } | null
          }>
        )('get_my_admin_summary'),
        (
          supabase.rpc as unknown as (
            fn: string,
          ) => Promise<{
            data: ChildUserRow[] | null
            error: { message: string } | null
          }>
        )('list_my_child_users'),
      ])
      if (sumRes.error) throw sumRes.error
      if (listRes.error) throw listRes.error
      setSummary((sumRes.data ?? [])[0] ?? null)
      setChildren(listRes.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const handleCreateChild = async () => {
    const email = addEmail.trim().toLowerCase()
    const password = addPassword
    const fullName = addFullName.trim()
    if (!email) {
      setCreateError('メールアドレスを入力してください')
      return
    }
    if (!password || password.length < 6) {
      setCreateError('パスワードは 6 文字以上で入力してください')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const { data, error: invErr } = await supabase.functions.invoke('admin-create-child-user', {
        body: {
          email,
          password,
          full_name: fullName || null,
        },
      })
      if (invErr) throw invErr
      const result = data as { ok?: boolean; warning?: string; error?: string }
      if (!result?.ok) {
        throw new Error(result?.error ?? '作成に失敗しました')
      }
      // フォームクリア + 一覧再取得
      setAddEmail('')
      setAddFullName('')
      setAddPassword('')
      setShowAddForm(false)
      await fetchAll()
      if (result.warning) {
        alert(`子ユーザーを作成しましたが、警告: ${result.warning}`)
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (userId: string, email: string) => {
    if (!confirm(`子ユーザー "${email}" を削除しますか？ ログインできなくなります。`)) {
      return
    }
    try {
      const { data, error: invErr } = await supabase.functions.invoke('admin-delete-child-user', {
        body: { user_id: userId },
      })
      if (invErr) throw invErr
      const result = data as { ok?: boolean; error?: string }
      if (!result?.ok) {
        throw new Error(result?.error ?? '削除に失敗しました')
      }
      await fetchAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }
  // 子ユーザー本人がこのページを開いたら使えない旨を表示
  const isChild = summary?.parent_user_id != null
  const canAddMore =
    summary?.child_user_limit == null ||
    (summary.child_user_count ?? 0) < (summary.child_user_limit ?? 0)

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link to="/" className="p-1.5 hover:bg-slate-100 rounded" title="トップへ">
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <Users className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">子ユーザー管理</h1>
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

      {isChild ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md bg-white border rounded-lg p-6 text-center">
            <Users className="h-8 w-8 text-slate-400 mx-auto mb-3" />
            <div className="text-base font-semibold mb-2">この画面は管理者専用です</div>
            <div className="text-sm text-slate-600">
              あなたは別の管理者が作成した子ユーザーです。子ユーザーをさらに
              作ることはできません。
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* サマリ */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="プラン" value={summary?.plan ? PLAN_LABEL[summary.plan] : '未設定'} />
            <SummaryCard
              label="子ユーザー数"
              value={`${summary?.child_user_count ?? 0} / ${
                summary?.child_user_limit ?? '無制限'
              }`}
            />
            <SummaryCard label="あなた" value={summary?.email ?? user.email ?? '-'} />
          </div>

          {/* 追加ボタン / フォーム */}
          {!showAddForm ? (
            <button
              onClick={() => setShowAddForm(true)}
              disabled={!canAddMore}
              className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={canAddMore ? '' : '子ユーザーの上限に達しています'}
            >
              <UserPlus className="h-4 w-4" />
              子ユーザーを追加
              {!canAddMore && '（上限到達）'}
            </button>
          ) : (
            <div className="bg-white border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm">新規子ユーザー</h2>
                <button
                  onClick={() => {
                    setShowAddForm(false)
                    setAddEmail('')
                    setAddFullName('')
                    setAddPassword('')
                    setCreateError(null)
                  }}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="メールアドレス *">
                  <input
                    type="email"
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    autoComplete="off"
                    className="w-full px-2 py-1.5 text-sm border rounded"
                    placeholder="child@example.com"
                  />
                </Field>
                <Field label="氏名（任意）">
                  <input
                    type="text"
                    value={addFullName}
                    onChange={(e) => setAddFullName(e.target.value)}
                    autoComplete="off"
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  />
                </Field>
                <Field label="初期パスワード *（6 文字以上）">
                  <input
                    type="text"
                    value={addPassword}
                    onChange={(e) => setAddPassword(e.target.value)}
                    autoComplete="new-password"
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono"
                    placeholder="6 文字以上"
                  />
                </Field>
              </div>
              <div className="text-[11px] text-slate-500">
                プランは作成者と同じものを継承します。作成と同時に、あなたが
                オーナーの全工事に「閲覧」権限で参加します。
              </div>
              {createError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {createError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowAddForm(false)}
                  disabled={creating}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleCreateChild}
                  disabled={creating || !addEmail.trim() || addPassword.length < 6}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  作成
                </button>
              </div>
            </div>
          )}

          {/* 一覧 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            {children.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">
                子ユーザーはまだいません。
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2">メール</th>
                    <th className="text-left px-3 py-2 w-48">氏名</th>
                    <th className="text-left px-3 py-2 w-40">最終ログイン</th>
                    <th className="text-left px-3 py-2 w-32">登録日</th>
                    <th className="text-left px-3 py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((c) => (
                    <tr key={c.user_id} className="border-t">
                      <td className="px-3 py-2 break-all">{c.email}</td>
                      <td className="px-3 py-2">{c.full_name ?? '-'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {c.last_sign_in_at
                          ? new Date(c.last_sign_in_at).toLocaleString('ja-JP')
                          : '-'}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {new Date(c.created_at).toLocaleDateString('ja-JP')}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleDelete(c.user_id, c.email)}
                          className="p-1 text-red-600 hover:bg-red-50 rounded"
                          title="削除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border rounded-lg p-3">
      <div className="text-[11px] text-slate-500 mb-1">{label}</div>
      <div className="text-sm font-semibold truncate" title={value}>
        {value}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  )
}
