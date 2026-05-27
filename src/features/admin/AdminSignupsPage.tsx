// 管理者用: 申し込み（signup_requests）の一覧・状況管理。
// /admin/signups（要ログイン＋管理者メール）。
import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Loader2, RefreshCw, ArrowLeft } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'

interface SignupRequest {
  id: string
  company_name: string
  contact_name: string
  email: string
  phone: string | null
  user_count: number | null
  plan_interest: string | null
  message: string | null
  status: string
  created_at: string
}

const STATUSES: { value: string; label: string; cls: string }[] = [
  { value: 'new', label: '未対応', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  { value: 'contacted', label: '連絡済', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  { value: 'closed', label: '完了', cls: 'bg-slate-100 text-slate-600 border-slate-300' },
]

const PLAN_LABEL: Record<string, string> = {
  civil: '農業土木',
  boundary: '境界測量',
  undecided: '未定/相談',
}

export function AdminSignupsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<SignupRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error } = await (
        supabase.from('signup_requests' as never) as unknown as {
          select: (c: string) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{
              data: SignupRequest[] | null
              error: { message: string } | null
            }>
          }
        }
      )
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      setRows(data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  const updateStatus = async (id: string, status: string) => {
    // 楽観的更新
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
    const { error } = await (
      supabase.from('signup_requests' as never) as unknown as {
        update: (p: { status: string }) => {
          eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
        }
      }
    )
      .update({ status })
      .eq('id', id)
    if (error) {
      setError('ステータス更新に失敗しました: ' + error.message)
      fetchRows()
    }
  }

  if (!isAdmin(user?.email)) {
    return <Navigate to="/" replace />
  }

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.status === filter)
  const counts = {
    all: rows.length,
    new: rows.filter((r) => r.status === 'new').length,
    contacted: rows.filter((r) => r.status === 'contacted').length,
    closed: rows.filter((r) => r.status === 'closed').length,
  }

  const fmt = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link to="/" className="text-slate-500 hover:text-slate-800" title="アプリへ">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-bold">申し込み管理</h1>
          <button
            onClick={fetchRows}
            className="ml-auto flex items-center gap-1 px-2 py-1 text-sm border rounded hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            更新
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* フィルタ */}
        <div className="flex items-center gap-2 mb-3 text-sm">
          {[
            { v: 'all', l: `すべて (${counts.all})` },
            { v: 'new', l: `未対応 (${counts.new})` },
            { v: 'contacted', l: `連絡済 (${counts.contacted})` },
            { v: 'closed', l: `完了 (${counts.closed})` },
          ].map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`px-3 py-1 rounded border ${
                filter === f.v ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-300'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500 py-10 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" /> 読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-400 py-10">該当する申し込みはありません</div>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => (
              <div key={r.id} className="bg-white border rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-bold text-base">{r.company_name}</div>
                    <div className="text-sm text-slate-600">
                      {r.contact_name}
                      <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">
                        {r.email}
                      </a>
                      {r.phone && <>　/　{r.phone}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{fmt(r.created_at)}</span>
                    <select
                      value={r.status}
                      onChange={(e) => updateStatus(r.id, e.target.value)}
                      className={`text-xs px-2 py-1 rounded border font-medium ${
                        STATUSES.find((s) => s.value === r.status)?.cls ?? ''
                      }`}
                    >
                      {STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="mt-2 text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                  <span>想定人数: <b>{r.user_count ?? '-'}</b></span>
                  <span>興味プラン: <b>{r.plan_interest ? PLAN_LABEL[r.plan_interest] ?? r.plan_interest : '-'}</b></span>
                </div>
                {r.message && (
                  <div className="mt-2 text-sm text-slate-600 bg-slate-50 rounded p-2 whitespace-pre-wrap">
                    {r.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
