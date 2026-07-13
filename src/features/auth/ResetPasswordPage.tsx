// パスワード再設定コールバックページ。
//
// フロー:
//   1. ユーザーがログイン画面「パスワードを忘れた方」でメアド入力
//   2. supabase.auth.resetPasswordForEmail() でリセットメール送信
//   3. メールのリンクをクリック → Supabase が verify → このページに redirect
//      URL の fragment に access_token / refresh_token / type=recovery が入り、
//      @supabase/supabase-js の onAuthStateChange が拾って自動で
//      「recovery セッション」を作る (PASSWORD_RECOVERY イベント)
//   4. このページで新しいパスワードを入力 → updateUser({password}) → 完了
//
// リカバリセッションは通常セッションと違い、パスワード更新のためだけの一時的な
// もの。updateUser 成功後にトップへ遷移する。

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'

const MIN_PASSWORD_LENGTH = 8

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false) // recovery セッションが確立したか
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Supabase の auth listener で PASSWORD_RECOVERY イベントを拾う。
    // 既にセッション確立済み (URL fragment を parse 済み) なら getSession でも取れる。
    let cancelled = false
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      if (data.session) setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setReady(true)
      }
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('確認用パスワードが一致しません')
      return
    }
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error
      setDone(true)
      // 2 秒後にトップへ
      setTimeout(() => navigate('/'), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-5 w-5 text-blue-600" />
          <h1 className="text-lg font-bold text-slate-900">
            パスワード再設定
          </h1>
        </div>

        {!ready ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            リンクを確認中…
          </div>
        ) : done ? (
          <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
            <Check className="h-4 w-4 flex-shrink-0" />
            パスワードを更新しました。トップに移動します…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed">
              新しいパスワードを入力してください ({MIN_PASSWORD_LENGTH} 文字以上)。
              更新後、そのままログイン状態になります。
            </p>
            {error && (
              <div className="flex items-center gap-2 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                {error}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                新しいパスワード *
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                新しいパスワード (確認) *
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
              />
              {showPassword ? (
                <>
                  <EyeOff className="h-3.5 w-3.5" /> パスワードを隠す
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" /> パスワードを表示
                </>
              )}
            </label>
            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={saving || !newPassword || !confirmPassword}
                className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                パスワードを更新
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
