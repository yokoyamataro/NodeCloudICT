import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { LogIn, Loader2, Mail, KeyRound, Check, X } from 'lucide-react'

/** ハイブリッド認証: パスワード or メール Magic Link を選べる。
 *  - 通常運用はパスワードでサッと入る (現場の通信不安定時にも強い)
 *  - パスワード忘れや招待直後は「メールでリンク送る」を使う */
export function LoginPage() {
  const [mode, setMode] = useState<'password' | 'magic'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState<string | null>(null) // 送信済メールを表示
  // パスワードリセット用モーダル
  const [showResetModal, setShowResetModal] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSending, setResetSending] = useState(false)
  const [resetSentTo, setResetSentTo] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const { signIn, sendMagicLink } = useAuth()
  const navigate = useNavigate()

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError(null)
    setResetSending(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      setResetSentTo(resetEmail)
    } catch (err) {
      setResetError(
        err instanceof Error ? err.message : 'メール送信に失敗しました',
      )
    } finally {
      setResetSending(false)
    }
  }

  const closeResetModal = () => {
    setShowResetModal(false)
    setResetEmail('')
    setResetSentTo(null)
    setResetError(null)
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signIn(email, password)
      // NodeCloud Mobility バリアントではドライバー画面に直行
      const { isMobilityApp } = await import('@/lib/appVariant')
      navigate(isMobilityApp() ? '/mobility/drive' : '/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleMagicSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    setMagicLinkSent(null)
    try {
      await sendMagicLink(email)
      setMagicLinkSent(email)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'ログインリンクの送信に失敗しました',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-slate-900">NodeCloud</h1>
          </div>

          {/* モード切替タブ */}
          <div className="flex border-b mb-4">
            <button
              type="button"
              onClick={() => {
                setMode('password')
                setError(null)
                setMagicLinkSent(null)
              }}
              className={`flex-1 flex items-center justify-center gap-1 py-2 text-sm font-medium border-b-2 ${
                mode === 'password'
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              パスワード
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('magic')
                setError(null)
                setMagicLinkSent(null)
              }}
              className={`flex-1 flex items-center justify-center gap-1 py-2 text-sm font-medium border-b-2 ${
                mode === 'magic'
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Mail className="h-3.5 w-3.5" />
              メールでログイン
            </button>
          </div>

          {error && (
            <div className="p-3 mb-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
              {error}
            </div>
          )}

          {magicLinkSent ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
                <Check className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">
                    ログインリンクを送信しました
                  </div>
                  <div className="text-xs mt-1 break-all">
                    {magicLinkSent}
                  </div>
                  <div className="text-xs mt-2 text-emerald-700">
                    メールを開いて「ログイン」ボタンをタップしてください。
                    数分以内に届かない場合は、迷惑メールフォルダも確認してください。
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMagicLinkSent(null)}
                className="w-full px-4 py-2 text-sm border rounded-md hover:bg-slate-50"
              >
                別のメールで送り直す
              </button>
            </div>
          ) : mode === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="example@email.com"
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  パスワード
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                ログイン
              </button>
              <div className="text-xs text-center text-slate-500">
                <button
                  type="button"
                  onClick={() => {
                    setShowResetModal(true)
                    setResetEmail(email)
                    setResetError(null)
                    setResetSentTo(null)
                  }}
                  className="text-blue-600 hover:underline"
                >
                  パスワードを忘れた方
                </button>
                <span className="mx-1 text-slate-300">/</span>
                <button
                  type="button"
                  onClick={() => {
                    setMode('magic')
                    setError(null)
                  }}
                  className="text-blue-600 hover:underline"
                >
                  メールでログイン
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleMagicSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="example@email.com"
                  autoComplete="email"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading || !email}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                ログインリンクを送信
              </button>
              <p className="text-xs text-slate-500 leading-relaxed">
                入力されたメールアドレスにログイン用リンクを送信します。
                リンクをクリックするとログインが完了します。
                <br />
                <span className="text-slate-400">
                  ※ 未登録の方は「新規お申し込み」からご登録ください。
                </span>
              </p>
            </form>
          )}

          <div className="mt-5 pt-4 border-t text-center text-sm">
            <span className="text-slate-500">初めての方は </span>
            <Link to="/apply" className="text-blue-600 font-medium hover:underline">
              新規お申し込み
            </Link>
            <span className="text-slate-400 mx-1">/</span>
            <Link to="/lp" className="text-blue-600 hover:underline">
              サービス紹介
            </Link>
          </div>

          <div className="mt-3 text-center text-xs">
            <Link to="/terms" className="text-slate-500 hover:text-slate-700 hover:underline">
              利用規約
            </Link>
            <span className="text-slate-300 mx-2">|</span>
            <Link to="/privacy" className="text-slate-500 hover:text-slate-700 hover:underline">
              プライバシーポリシー
            </Link>
          </div>

          <p className="mt-6 text-center text-xs text-slate-500">
            開発者：
            <a
              href="https://yokoyama-s.jp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              有限会社横山測量設計事務所
            </a>
          </p>
        </div>
      </div>

      {/* パスワード再設定モーダル */}
      {showResetModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000] p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-slate-900">
                パスワード再設定
              </h3>
              <button
                onClick={closeResetModal}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
                aria-label="閉じる"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {resetSentTo ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
                  <Check className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">
                      再設定用リンクを送信しました
                    </div>
                    <div className="text-xs mt-1 break-all">{resetSentTo}</div>
                    <div className="text-xs mt-2 text-emerald-700">
                      メールを開いて「パスワードを再設定」ボタンをクリックしてください。
                      リンクは 1 時間有効です。届かない場合は迷惑メールもご確認ください。
                    </div>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={closeResetModal}
                    className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-3">
                <p className="text-xs text-slate-600 leading-relaxed">
                  ご登録のメールアドレスを入力してください。
                  パスワード再設定用のリンクを送信します。
                </p>
                {resetError && (
                  <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
                    {resetError}
                  </div>
                )}
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  autoComplete="email"
                  required
                  placeholder="example@email.com"
                  className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeResetModal}
                    disabled={resetSending}
                    className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={resetSending || !resetEmail}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {resetSending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mail className="h-4 w-4" />
                    )}
                    再設定リンクを送信
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
