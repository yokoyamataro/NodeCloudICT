import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { LogIn, Loader2, UserCircle } from 'lucide-react'

// デモアカウント
const DEMO_EMAIL = 'demo@nodecloud.jp'
const DEMO_PASSWORD = 'demo1234'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const { signIn } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
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

  const handleDemoLogin = async () => {
    setError(null)
    setDemoLoading(true)

    try {
      await signIn(DEMO_EMAIL, DEMO_PASSWORD)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'デモログインに失敗しました')
    } finally {
      setDemoLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-slate-900">NodeCloud Design</h1>
            <p className="text-sm text-slate-600 mt-1">ICT設計システム</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
                {error}
              </div>
            )}

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
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading || demoLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              ログイン
            </button>
          </form>

          <div className="mt-4">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-2 text-slate-500">または</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={loading || demoLoading}
              className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {demoLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserCircle className="h-4 w-4" />
              )}
              デモアカウントでログイン
            </button>
          </div>

          <p className="mt-6 text-center text-xs text-slate-500">
            NodeCloud本体と同じアカウントでログインできます
          </p>
        </div>
      </div>
    </div>
  )
}
