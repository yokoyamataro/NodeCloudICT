// 管理者 用: サポート フォーム (/support#contact) からの お問い合わせ 一覧。
// /admin/contacts (要 ログイン + 管理者 メール)。
//
// データ 元: public.contact_messages (/api/contact が service role で INSERT)
// ステータス: new / replied / closed。 UI から 更新可能。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Mail, Phone, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'

interface ContactMessage {
  id: string
  ticket_id: string
  topic: string
  name: string
  company: string | null
  email: string
  phone: string | null
  message: string
  status: string
  user_agent: string | null
  ip_address: string | null
  created_at: string
}

const STATUSES: { value: string; label: string; cls: string }[] = [
  { value: 'new', label: '未対応', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  { value: 'replied', label: '返信済', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  { value: 'closed', label: '完了', cls: 'bg-slate-100 text-slate-600 border-slate-300' },
]

export function AdminContactsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState<ContactMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [query, setQuery] = useState('')

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Supabase の 型生成 を 通して いない テーブル を 使う ので as unknown で 包む。
      const { data, error } = await (
        supabase.from('contact_messages' as never) as unknown as {
          select: (c: string) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{
              data: ContactMessage[] | null
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
    // 楽観 更新 → 失敗時 は 再取得
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
    const { error } = await (
      supabase.from('contact_messages' as never) as unknown as {
        update: (p: { status: string }) => {
          eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
        }
      }
    )
      .update({ status })
      .eq('id', id)
    if (error) {
      setError('ステータス更新に失敗しました: ' + error.message)
      void fetchRows()
    }
  }

  if (!isAdmin(user?.email)) {
    return <Navigate to="/" replace />
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return (
        r.ticket_id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.company ?? '').toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.message.toLowerCase().includes(q) ||
        r.topic.toLowerCase().includes(q)
      )
    })
  }, [rows, filter, query])

  const counts = {
    all: rows.length,
    new: rows.filter((r) => r.status === 'new').length,
    replied: rows.filter((r) => r.status === 'replied').length,
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
          <h1 className="font-bold">お問い合わせ</h1>
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
        {/* フィルタ + 検索 */}
        <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
          {(
            [
              { v: 'all', l: `すべて (${counts.all})` },
              { v: 'new', l: `未対応 (${counts.new})` },
              { v: 'replied', l: `返信済 (${counts.replied})` },
              { v: 'closed', l: `完了 (${counts.closed})` },
            ] as const
          ).map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`px-3 py-1 rounded border ${
                filter === f.v
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white border-slate-300'
              }`}
            >
              {f.l}
            </button>
          ))}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="受付番号・名前・会社・メール・本文で検索"
            className="ml-auto min-w-60 px-3 py-1 rounded border border-slate-300"
          />
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
          <div className="text-center text-slate-400 py-10">該当する問い合わせはありません</div>
        ) : (
          <div className="space-y-3">
            {filtered.map((r) => {
              const st = STATUSES.find((s) => s.value === r.status) ?? STATUSES[0]
              return (
                <div key={r.id} className="bg-white border rounded-lg p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-slate-500">{r.ticket_id}</span>
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded border ${st.cls}`}
                        >
                          {st.label}
                        </span>
                        <span className="text-xs text-slate-400">{r.topic}</span>
                      </div>
                      <div className="font-bold text-base mt-1">
                        {r.name}
                        {r.company && (
                          <span className="font-normal text-slate-600 ml-2">
                            / {r.company}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-slate-600 flex items-center gap-3 flex-wrap mt-1">
                        <a
                          href={`mailto:${r.email}?subject=Re:%20【NodeCloud】お問い合わせ（${encodeURIComponent(
                            r.ticket_id,
                          )}）`}
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          {r.email}
                        </a>
                        {r.phone && (
                          <a
                            href={`tel:${r.phone}`}
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            <Phone className="h-3.5 w-3.5" />
                            {r.phone}
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">{fmt(r.created_at)}</span>
                      <select
                        value={r.status}
                        onChange={(e) => updateStatus(r.id, e.target.value)}
                        className="text-xs border rounded px-2 py-1"
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <pre className="mt-3 text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 border rounded p-3">
                    {r.message}
                  </pre>
                  {(r.user_agent || r.ip_address) && (
                    <div className="mt-2 text-[11px] text-slate-400 font-mono">
                      {r.ip_address && <>IP: {r.ip_address}　</>}
                      {r.user_agent && <>UA: {r.user_agent}</>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
