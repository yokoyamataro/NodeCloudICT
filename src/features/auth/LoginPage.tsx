import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { LogIn, Loader2, Mail, KeyRound, Check } from 'lucide-react'

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
  const { signIn, sendMagicLink } = useAuth()
  const navigate = useNavigate()

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signIn(email, password)
      navigate('/')
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
            <p className="text-sm text-slate-600 mt-1">ICT農業土木施工システム</p>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-3 inline-block">
              開発中プロトタイプです
            </p>
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
                パスワードを忘れた方は{' '}
                <button
                  type="button"
                  onClick={() => {
                    setMode('magic')
                    setError(null)
                  }}
                  className="text-blue-600 hover:underline"
                >
                  メールでログイン
                </button>{' '}
                をご利用ください
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
    </div>
  )
}
