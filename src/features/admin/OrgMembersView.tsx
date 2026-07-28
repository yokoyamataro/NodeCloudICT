// 組織管理者用のメンバー管理ビュー。
// AdminUsersPage から、非サイトオーナー (＝組織 admin) がアクセスしたとき使う。
//
// 機能:
//   * list_org_members(org_id) で自組織のメンバー一覧を表示
//   * 氏名編集 (org_admin_set_full_name)
//   * 役割変更 admin ⇔ member (org_change_member_role)
//   * 組織から外す (org_remove_member)
//   * メンバー招待 (invite-member Edge Function を organization_id + org_role で呼ぶ)
//
// サイトオーナーもこのビューを共通で使える (組織管理画面のセカンダリ動線として)。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  UserMinus,
  UserPlus,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

/** list_org_members(p_org_id) の返り値 */
interface OrgMemberRow {
  user_id: string
  email: string
  full_name: string | null
  phone: string | null
  role: 'admin' | 'member'
  joined_at: string
  invited_by: string | null
  last_sign_in_at: string | null
}

interface Props {
  organizationId: string
  organizationName: string
  /** organizations.user_count_limit (null = 無制限)。招待ボタン活性判定に使う */
  userCountLimit?: number | null
  /** organizations.expires_at (null = 無期限)。招待ボタン活性判定に使う */
  expiresAt?: string | null
}

/** SECURITY DEFINER RPC を型なしで呼ぶための thin ラッパ (Supabase の生成型に
 *  新しい RPC が入っていないため as never キャストで回避) */
async function callRpc<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  return (await supabase.rpc(fn as never, (args ?? {}) as never)) as unknown as {
    data: T | null
    error: { message: string } | null
  }
}

export function OrgMembersView({
  organizationId,
  organizationName,
  userCountLimit = null,
  expiresAt = null,
}: Props) {
  const { user } = useAuth()
  const [members, setMembers] = useState<OrgMemberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 各行の氏名・電話番号編集ドラフト (user_id -> draft)
  const [nameDrafts, setNameDrafts] = useState<Map<string, string>>(new Map())
  const [phoneDrafts, setPhoneDrafts] = useState<Map<string, string>>(new Map())
  const [savingUsers, setSavingUsers] = useState<Set<string>>(new Set())
  const [inviteOpen, setInviteOpen] = useState(false)

  const fetchMembers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error } = await callRpc<OrgMemberRow[]>(
        'list_org_members',
        { p_org_id: organizationId },
      )
      if (error) throw error
      const list = (data ?? []) as OrgMemberRow[]
      setMembers(list)
      const names = new Map<string, string>()
      const phones = new Map<string, string>()
      for (const m of list) {
        names.set(m.user_id, m.full_name ?? '')
        phones.set(m.user_id, m.phone ?? '')
      }
      setNameDrafts(names)
      setPhoneDrafts(phones)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'メンバー取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void fetchMembers()
  }, [fetchMembers])

  const adminCount = useMemo(
    () => members.filter((m) => m.role === 'admin').length,
    [members],
  )

  const withSaving = async (userId: string, fn: () => Promise<void>) => {
    setSavingUsers((prev) => new Set(prev).add(userId))
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作に失敗しました')
    } finally {
      setSavingUsers((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    }
  }

  const handleSaveName = (m: OrgMemberRow) => {
    const draft = nameDrafts.get(m.user_id) ?? ''
    if (draft.trim() === (m.full_name ?? '').trim()) return
    void withSaving(m.user_id, async () => {
      const { error } = await callRpc('org_admin_set_full_name', {
        p_user_id: m.user_id,
        p_full_name: draft.trim(),
      })
      if (error) throw error
      setMembers((prev) =>
        prev.map((x) =>
          x.user_id === m.user_id ? { ...x, full_name: draft.trim() } : x,
        ),
      )
    })
  }

  const handleSavePhone = (m: OrgMemberRow) => {
    const draft = phoneDrafts.get(m.user_id) ?? ''
    // 空白 trim + hyphen 等の見た目を保持 (server 側で NULLIF して保存)
    const normalized = draft.trim()
    if (normalized === (m.phone ?? '').trim()) return
    void withSaving(m.user_id, async () => {
      const { error } = await callRpc('org_admin_set_phone', {
        p_user_id: m.user_id,
        p_phone: normalized,
      })
      if (error) throw error
      setMembers((prev) =>
        prev.map((x) =>
          x.user_id === m.user_id
            ? { ...x, phone: normalized === '' ? null : normalized }
            : x,
        ),
      )
    })
  }

  const handleChangeRole = (m: OrgMemberRow, newRole: 'admin' | 'member') => {
    if (newRole === m.role) return
    // 最後の admin を降格しようとしていないか UI 側でも軽く警告
    if (m.role === 'admin' && newRole === 'member' && adminCount <= 1) {
      alert(
        '最後の管理者を一般に降格することはできません。\n先に別のメンバーを管理者に昇格してください。',
      )
      return
    }
    void withSaving(m.user_id, async () => {
      const { error } = await callRpc('org_change_member_role', {
        p_org_id: organizationId,
        p_user_id: m.user_id,
        p_role: newRole,
      })
      if (error) throw error
      setMembers((prev) =>
        prev.map((x) => (x.user_id === m.user_id ? { ...x, role: newRole } : x)),
      )
    })
  }

  const handleRemove = (m: OrgMemberRow) => {
    if (m.role === 'admin' && adminCount <= 1) {
      alert(
        '最後の管理者を組織から外すことはできません。\n先に別のメンバーを管理者に昇格してください。',
      )
      return
    }
    const label = m.full_name ? `${m.full_name} (${m.email})` : m.email
    if (
      !confirm(
        `メンバー「${label}」をこの組織から外します。\n\n` +
          '・アカウントは削除されません\n' +
          '・組織に紐づく編集権限は失われます\n\n' +
          'よろしいですか?',
      )
    ) {
      return
    }
    void withSaving(m.user_id, async () => {
      const { error } = await callRpc('org_remove_member', {
        p_org_id: organizationId,
        p_user_id: m.user_id,
      })
      if (error) throw error
      setMembers((prev) => prev.filter((x) => x.user_id !== m.user_id))
    })
  }

  return (
    <div className="flex-1 overflow-auto">
      {inviteOpen && (
        <InviteMemberModal
          organizationId={organizationId}
          organizationName={organizationName}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false)
            void fetchMembers()
          }}
        />
      )}
      <div className="px-4 py-3 bg-white border-b flex items-center gap-2 flex-wrap">
        <div className="text-sm">
          <span className="text-slate-500">組織: </span>
          <span className="font-semibold text-slate-900">
            {organizationName}
          </span>
          <span className="ml-2 text-slate-400 text-xs">
            ({members.length} 名{userCountLimit != null ? ` / 上限 ${userCountLimit}` : ''}
            {' · '}管理者 {adminCount})
          </span>
          {(() => {
            const isExpired = !!expiresAt && new Date(expiresAt) < new Date()
            const atLimit =
              userCountLimit != null && members.length >= userCountLimit
            if (isExpired) {
              return (
                <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 border border-red-200">
                  期限切れ
                </span>
              )
            }
            if (atLimit) {
              return (
                <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                  上限到達
                </span>
              )
            }
            return null
          })()}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {(() => {
            const isExpired = !!expiresAt && new Date(expiresAt) < new Date()
            const atLimit =
              userCountLimit != null && members.length >= userCountLimit
            const blocked = isExpired || atLimit
            return (
              <button
                onClick={() => setInviteOpen(true)}
                disabled={blocked}
                title={
                  isExpired
                    ? '組織の利用期限が切れているため招待できません'
                    : atLimit
                      ? `ユーザー数上限 (${userCountLimit}) に達しているため招待できません`
                      : ''
                }
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <UserPlus className="h-3.5 w-3.5" />
                メンバー招待
              </button>
            )
          })()}
          <button
            onClick={fetchMembers}
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
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && members.length === 0 ? (
        <div className="h-full flex items-center justify-center text-slate-500 text-sm">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          読み込み中…
        </div>
      ) : members.length === 0 ? (
        <div className="p-8 text-center text-slate-500 text-sm">
          この組織にはまだメンバーがいません。「メンバー招待」から追加してください。
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
            <tr>
              <th className="text-left px-3 py-2">メール</th>
              <th className="text-left px-3 py-2 w-40">氏名</th>
              <th className="text-left px-3 py-2 w-36">電話番号</th>
              <th className="text-left px-3 py-2 w-24">役割</th>
              <th className="text-left px-3 py-2 w-28">参加日</th>
              <th className="text-left px-3 py-2 w-28">最終ログイン</th>
              <th className="text-left px-3 py-2 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const nameDraft = nameDrafts.get(m.user_id) ?? ''
              const phoneDraft = phoneDrafts.get(m.user_id) ?? ''
              const saving = savingUsers.has(m.user_id)
              const isSelf = m.user_id === user?.id
              const nameChanged =
                nameDraft.trim() !== (m.full_name ?? '').trim()
              const phoneChanged =
                phoneDraft.trim() !== (m.phone ?? '').trim()
              return (
                <tr key={m.user_id} className="border-b hover:bg-slate-50/50">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium break-all">{m.email}</div>
                    {isSelf && (
                      <div className="text-[10px] text-blue-600 mt-0.5">
                        あなた
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) =>
                        setNameDrafts((prev) => {
                          const next = new Map(prev)
                          next.set(m.user_id, e.target.value)
                          return next
                        })
                      }
                      onBlur={() => handleSaveName(m)}
                      placeholder="(未設定)"
                      className="w-full px-2 py-1 text-sm border rounded"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="tel"
                      value={phoneDraft}
                      onChange={(e) => {
                        // 自由入力を許可 (数字 / ハイフン / 括弧 / 空白 / + )
                        // 明らかなノイズは除去
                        const cleaned = e.target.value.replace(
                          /[^\d\-() +]/g,
                          '',
                        )
                        setPhoneDrafts((prev) => {
                          const next = new Map(prev)
                          next.set(m.user_id, cleaned)
                          return next
                        })
                      }}
                      onBlur={() => handleSavePhone(m)}
                      placeholder="090-1234-5678"
                      className="w-full px-2 py-1 text-sm border rounded font-mono"
                      autoComplete="tel"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={m.role}
                      onChange={(e) =>
                        handleChangeRole(m, e.target.value as 'admin' | 'member')
                      }
                      disabled={saving}
                      className={`w-full px-2 py-1 text-xs border rounded bg-white font-medium ${
                        m.role === 'admin'
                          ? 'text-amber-800 border-amber-300 bg-amber-50'
                          : 'text-slate-700'
                      }`}
                    >
                      <option value="admin">管理者</option>
                      <option value="member">一般</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-500">
                    {new Date(m.joined_at).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-500">
                    {m.last_sign_in_at
                      ? new Date(m.last_sign_in_at).toLocaleDateString('ja-JP')
                      : '-'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center gap-1 flex-wrap">
                      {(nameChanged || phoneChanged) && (
                        <button
                          onClick={() => {
                            if (nameChanged) handleSaveName(m)
                            if (phoneChanged) handleSavePhone(m)
                          }}
                          disabled={saving}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          {saving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                          保存
                        </button>
                      )}
                      <button
                        onClick={() => handleRemove(m)}
                        disabled={saving}
                        className="flex items-center gap-1 px-2 py-1 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                        title={
                          isSelf
                            ? 'あなた自身がこの組織から抜けます'
                            : 'この組織から外す (アカウントは残ります)'
                        }
                      >
                        <UserMinus className="h-3 w-3" />
                        {isSelf ? '脱退' : '外す'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ============================================================
// InviteMemberModal
// ============================================================
function InviteMemberModal({
  organizationId,
  organizationName,
  onClose,
  onInvited,
}: {
  organizationId: string
  organizationName: string
  onClose: () => void
  onInvited: () => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (!email.trim()) return
    setBusy(true)
    try {
      // Edge Function `invite-member` を organization_id + org_role で呼ぶ。
      // Phase 3 で EF を拡張する前提。EF 未デプロイなら 404 or invalid arg エラー。
      const { data, error: fnErr } = await supabase.functions.invoke(
        'invite-member',
        {
          body: {
            email: email.trim(),
            organization_id: organizationId,
            org_role: role,
          },
        },
      )
      if (fnErr) throw fnErr
      const result = (data ?? {}) as {
        ok?: boolean
        status?: 'invited' | 'added_existing_user' | string
        error?: string
        /** 既存ユーザー追加時に通知メールが送れたか */
        notified?: boolean
        notify_error?: string | null
      }
      if (!result.ok) {
        throw new Error(result.error ?? 'メンバー招待に失敗しました')
      }
      if (result.status === 'added_existing_user') {
        setMessage(
          result.notified
            ? `${email} を組織に追加し、通知メールを送信しました`
            : `${email} を組織に追加しました${
                result.notify_error ? ` (通知メール失敗: ${result.notify_error})` : ''
              }`,
        )
      } else {
        setMessage(`${email} に招待メールを送信しました`)
      }
      setTimeout(onInvited, 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : '招待に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-base font-semibold mb-1">メンバー招待</h3>
        <p className="text-xs text-slate-500 mb-4">
          {organizationName} に追加するメンバーのメールアドレスを入力してください。
          既にアプリに登録済みのユーザーはその場で組織に追加、未登録なら招待メールが
          送信されます。
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              メールアドレス *
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="example@email.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              役割
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              className="w-full px-3 py-2 text-sm border rounded bg-white"
            >
              <option value="member">一般</option>
              <option value="admin">管理者</option>
            </select>
          </div>
          {error && (
            <div className="flex items-center gap-2 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </div>
          )}
          {message && (
            <div className="flex items-center gap-2 p-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded">
              <Check className="h-3.5 w-3.5 flex-shrink-0" />
              {message}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              送信
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
