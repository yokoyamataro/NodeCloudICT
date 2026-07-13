// パスワード変更ページ。ログイン中のユーザーが自分のパスワードを設定/変更する。
//
// 使い方:
//   * 通常変更: 現在のパスワードで再認証してから新しいパスワードに更新。
//   * パスワードを忘れた場合: ログイン画面から「メールでログイン (Magic Link)」で
//     入り直してから、このページで新しいパスワードを設定する。
//     Supabase の Magic Link ログイン後は現在パスワード無しで updateUser 可能。

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

const MIN_PASSWORD_LENGTH = 8

export function PasswordSettingsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`新しいパスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('新しいパスワードと確認用が一致しません')
      return
    }
    setSaving(true)
    try {
      // 1) 現在のパスワードが入力されていれば、まず再認証で本人確認する
      //    (Magic Link で入り直した直後などは省略できるようにオプショナル)
      if (currentPassword) {
        const email = user?.email
        if (!email) {
          throw new Error('メールアドレスが取得できません。再ログインしてください')
        }
        const { error: reauthError } = await supabase.auth.signInWithPassword({
          email,
          password: currentPassword,
        })
        if (reauthError) {
          throw new Error('現在のパスワードが正しくありません')
        }
      }
      // 2) 新しいパスワードに更新
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      })
      if (updateError) throw updateError
      setMessage('パスワードを更新しました')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      // 3 秒後にトップに戻す (ユーザーが確認するチャンスを残す)
      setTimeout(() => navigate('/'), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link
          to="/"
          className="p-1.5 hover:bg-slate-100 rounded"
          title="トップへ"
        >
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <KeyRound className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold">パスワード設定</h1>
      </header>

      <div className="max-w-md mx-auto p-4 space-y-4">
        <div className="bg-white border rounded-lg p-4 text-xs text-slate-600 leading-relaxed">
          {user?.email && (
            <div className="mb-2">
              <span className="text-slate-500">アカウント: </span>
              <span className="font-medium text-slate-800">{user.email}</span>
            </div>
          )}
          <p>
            通常はセキュリティのため「現在のパスワード」も入力してください。
            <br />
            <span className="text-slate-500">
              パスワードを忘れて Magic Link (メールリンク) 経由でログインした直後は、
              現在のパスワードを空欄のままにして新しいパスワードだけ設定できます。
            </span>
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}
        {message && (
          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
            <Check className="h-4 w-4 flex-shrink-0" />
            {message}
          </div>
        )}

        <form
          onSubmit={handleSave}
          className="bg-white border rounded-lg p-4 space-y-3"
        >
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              現在のパスワード{' '}
              <span className="text-slate-400 font-normal">
                (Magic Link 直後は不要)
              </span>
            </label>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              新しいパスワード * ({MIN_PASSWORD_LENGTH} 文字以上)
            </label>
            <input
              type={showPasswords ? 'text' : 'password'}
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
              type={showPasswords ? 'text' : 'password'}
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
              checked={showPasswords}
              onChange={(e) => setShowPasswords(e.target.checked)}
            />
            {showPasswords ? (
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
              disabled={
                saving || !newPassword || !confirmPassword
              }
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              更新
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
