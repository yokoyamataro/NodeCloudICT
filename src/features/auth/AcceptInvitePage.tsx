// 招待リンク受け取りページ。
//
// 動作:
//   - Supabase Auth が招待メール内リンクのトークンを検証し、このページに
//     セッション付きで戻してくる（supabase-js が URL ハッシュを自動処理）。
//   - 本人にパスワードを設定してもらい、設定完了で / に遷移する。
//   - プロジェクトへの参加は handle_pending_invitations トリガが auth.users INSERT
//     を拾って自動でやってくれるので、ここでは触らない。

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Lock, CheckCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export function AcceptInvitePage() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 認証状態が確定するまで待つ。未ログインの場合はリンク切れと案内。
  useEffect(() => {
    if (loading) return
    // すでにパスワード設定済みの完全ログインユーザーで来た場合はそのままトップへ
    // …とはしない。招待先プロジェクトを確実に閲覧できるよう本人にパスワードを
    // 設定してもらってからにする。
  }, [loading])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('パスワードは 8 文字以上で設定してください')
      return
    }
    if (password !== confirmPassword) {
      setError('パスワードが一致しません')
      return
    }
    setSubmitting(true)
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password })
      if (updateErr) throw updateErr
      setSuccess(true)
      setTimeout(() => navigate('/', { replace: true }), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パスワードの設定に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="w-full max-w-md bg-white rounded-lg shadow p-6 text-center">
          <h1 className="text-lg font-bold text-slate-900 mb-2">招待リンクが無効です</h1>
          <p className="text-sm text-slate-600 mb-4">
            リンクの有効期限が切れているか、すでに使用されている可能性があります。招待者に再送をお願いしてください。
          </p>
          <a href="/login" className="text-sm text-blue-600 hover:underline">
            ログイン画面へ
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-full max-w-md bg-white rounded-lg shadow p-8">
        <div className="text-center mb-6">
          <Lock className="h-10 w-10 text-blue-600 mx-auto mb-2" />
          <h1 className="text-xl font-bold text-slate-900">パスワードを設定</h1>
          <p className="text-sm text-slate-600 mt-1">
            {user.email} としてログイン中。最初のパスワードを決めてください。
          </p>
        </div>

        {success ? (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            設定完了！リダイレクトします…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
                {error}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                新しいパスワード
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="8 文字以上"
                required
                autoFocus
                minLength={8}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                確認のためもう一度
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
                minLength={8}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              パスワードを設定
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
