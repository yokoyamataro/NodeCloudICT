// 登記情報提供サービス (touki.or.jp) の ID/PW をユーザーごと保存する画面。
//
// セキュリティ:
//   * 実データは pgcrypto + Supabase Vault で暗号化して DB に保存。
//     クライアントには plaintext を保持せず、必要になったときだけ RPC で取得。
//   * ページ表示時は has_registry_credentials() だけ呼び、
//     「登録済みか / 最終更新日時」のみを表示。
//   * 「登録内容を確認 / 編集」ボタンで初めて get_registry_credentials() を呼ぶ。

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  Trash2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export function RegistryCredentialsPage() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasCredentials, setHasCredentials] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [editing, setEditing] = useState(false) // フォーム表示中か
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refetchStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error } = (await supabase.rpc(
        'has_registry_credentials' as never,
      )) as unknown as {
        data:
          | Array<{ exists_flag: boolean; updated_at: string | null }>
          | { exists_flag: boolean; updated_at: string | null }
          | null
        error: { message: string } | null
      }
      if (error) throw error
      const row = Array.isArray(data) ? data[0] : data
      setHasCredentials(!!row?.exists_flag)
      setLastUpdatedAt(row?.updated_at ?? null)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '登録状況の取得に失敗しました',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetchStatus()
  }, [refetchStatus])

  const handleStartEdit = async () => {
    setError(null)
    setMessage(null)
    if (!hasCredentials) {
      // 新規登録: 空フォーム
      setUsername('')
      setPassword('')
      setEditing(true)
      return
    }
    // 既存の値を復号して取得
    setLoading(true)
    try {
      const { data, error } = (await supabase.rpc(
        'get_registry_credentials' as never,
      )) as unknown as {
        data:
          | Array<{ username: string; password: string; updated_at: string }>
          | { username: string; password: string; updated_at: string }
          | null
        error: { message: string } | null
      }
      if (error) throw error
      const row = Array.isArray(data) ? data[0] : data
      if (row) {
        setUsername(row.username ?? '')
        setPassword(row.password ?? '')
      }
      setEditing(true)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '認証情報の取得に失敗しました',
      )
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!username.trim() || !password) {
      setError('ID とパスワードを入力してください')
      return
    }
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const { error } = (await supabase.rpc(
        'save_registry_credentials' as never,
        {
          p_username: username.trim(),
          p_password: password,
        } as never,
      )) as unknown as { error: { message: string } | null }
      if (error) throw error
      setEditing(false)
      // 保管を確実にクリア (再表示時は has でチェック → get で取り直し)
      setUsername('')
      setPassword('')
      setShowPassword(false)
      setMessage('保存しました')
      await refetchStatus()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err && 'message' in err && typeof (err as { message: unknown }).message === 'string'
            ? (err as { message: string }).message
            : `保存に失敗しました: ${JSON.stringify(err)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setEditing(false)
    setUsername('')
    setPassword('')
    setShowPassword(false)
    setError(null)
  }

  const handleDelete = async () => {
    if (
      !confirm(
        '登記情報提供サービスの認証情報を削除します。よろしいですか?',
      )
    ) {
      return
    }
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const { error } = (await supabase.rpc(
        'delete_registry_credentials' as never,
      )) as unknown as { error: { message: string } | null }
      if (error) throw error
      setMessage('削除しました')
      setEditing(false)
      setUsername('')
      setPassword('')
      await refetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
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
        <h1 className="text-lg font-bold">登記情報提供サービスの認証情報</h1>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-800 mb-2">
            {user?.email ? `${user.email} の認証情報` : '認証情報'}
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            <a
              href="https://www1.touki.or.jp/gateway.html"
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline"
            >
              登記情報提供サービス
            </a>{' '}
            (touki.or.jp) の ログイン ID とパスワードを保存します。
            <br />
            サーバー側で対称鍵暗号化 (pgcrypto + Supabase Vault) を用い、
            他のユーザーからは見えません。ご自身以外がこの端末を利用する場合は、
            ブラウザを閉じるか、下のフォームからログアウトしてください。
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

        {loading ? (
          <div className="flex items-center gap-2 px-3 py-6 justify-center text-slate-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            読込中…
          </div>
        ) : editing ? (
          <div className="bg-white border rounded-lg p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                ログイン ID *
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="例: touki-user-01"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                パスワード *
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-3 py-2 pr-9 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-700"
                  title={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={handleCancel}
                disabled={saving}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !username.trim() || !password}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border rounded-lg p-4 space-y-3">
            {hasCredentials ? (
              <>
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <Check className="h-4 w-4" />
                  登録済み
                </div>
                {lastUpdatedAt && (
                  <div className="text-xs text-slate-500">
                    最終更新: {new Date(lastUpdatedAt).toLocaleString('ja-JP')}
                  </div>
                )}
                <div className="flex items-center gap-2 pt-2">
                  <button
                    onClick={handleStartEdit}
                    className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                  >
                    登録内容を確認 / 変更
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={saving}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-700 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    削除
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm text-slate-600">
                  まだ認証情報は登録されていません。
                </div>
                <button
                  onClick={handleStartEdit}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  新規登録
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
