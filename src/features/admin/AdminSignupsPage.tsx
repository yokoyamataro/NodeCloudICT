// 管理者用: 申し込み（signup_requests）の一覧・状況管理。
// /admin/signups（要ログイン＋管理者メール）。
import { useEffect, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Loader2, RefreshCw, ArrowLeft, Building2, X, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { Organization } from '@/types/database'

interface SignupRequest {
  id: string
  company_name: string
  industry: string | null
  postal_code: string | null
  address: string | null
  contact_name: string
  email: string
  phone: string | null
  user_count: number | null
  plan_interest: string | null
  has_android: string | null
  has_drogger: string | null
  gnss_correction: string | null
  source: string | null
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

  // 「組織を作成」承認ダイアログのソース申込。null なら閉じている
  const [creatingFor, setCreatingFor] = useState<SignupRequest | null>(null)

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
                    {r.status !== 'closed' && (
                      <button
                        onClick={() => setCreatingFor(r)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-emerald-600 text-white rounded border border-emerald-700 hover:bg-emerald-700"
                        title="申込内容を元に組織を作成する"
                      >
                        <Building2 className="h-3.5 w-3.5" />
                        組織を作成
                      </button>
                    )}
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
                  {r.industry && <span>業種: <b>{r.industry}</b></span>}
                  <span>想定人数: <b>{r.user_count ?? '-'}</b></span>
                  <span>興味プラン: <b>{r.plan_interest ? PLAN_LABEL[r.plan_interest] ?? r.plan_interest : '-'}</b></span>
                  {r.source && <span>きっかけ: <b>{r.source}</b></span>}
                  {r.has_android && <span>Android: <b>{r.has_android}</b></span>}
                  {r.has_drogger && <span>Drogger: <b>{r.has_drogger}</b></span>}
                  {r.gnss_correction && <span>補正: <b>{r.gnss_correction}</b></span>}
                </div>
                {(r.postal_code || r.address) && (
                  <div className="mt-1 text-sm text-slate-600">
                    住所: {r.postal_code ? `〒${r.postal_code} ` : ''}{r.address ?? ''}
                  </div>
                )}
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

      {creatingFor && (
        <CreateOrgFromSignupDialog
          signup={creatingFor}
          onClose={() => setCreatingFor(null)}
          onCreated={async () => {
            // 申込ステータスを完了に遷移し、閉じる
            await updateStatus(creatingFor.id, 'closed')
            setCreatingFor(null)
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  )
}

// 承認 (組織作成) ダイアログ。申込内容を元にフィールドを事前入力し、
// サイトオーナーが確認/微修正して organizations に INSERT する。
// admin_user_id は NULL (未設定)。ユーザー登録後にユーザー管理から紐付ける運用。
function CreateOrgFromSignupDialog({
  signup,
  onClose,
  onCreated,
  onError,
}: {
  signup: SignupRequest
  onClose: () => void
  onCreated: () => void | Promise<void>
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(signup.company_name)
  const [postalCode, setPostalCode] = useState(signup.postal_code ?? '')
  const [address, setAddress] = useState(signup.address ?? '')
  const [phone, setPhone] = useState(signup.phone ?? '')
  const [representative, setRepresentative] = useState(signup.contact_name)
  const [userCountLimit, setUserCountLimit] = useState<string>(
    signup.user_count == null ? '' : String(signup.user_count),
  )
  const [plan, setPlan] = useState(
    signup.plan_interest ? PLAN_LABEL[signup.plan_interest] ?? signup.plan_interest : '',
  )
  const [note, setNote] = useState(
    signup.message ? `申込時メッセージ:\n${signup.message}` : '',
  )
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) {
      setLocalError('組織名は必須です')
      return
    }
    let limit: number | null = null
    if (userCountLimit.trim() !== '') {
      const n = Number(userCountLimit)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        setLocalError('ユーザー数は 0 以上の整数で入力してください')
        return
      }
      limit = n
    }
    setSaving(true)
    setLocalError(null)
    try {
      const payload = {
        name: name.trim(),
        postal_code: postalCode.trim() || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        representative: representative.trim() || null,
        user_count_limit: limit,
        plan: plan.trim() || null,
        note: note.trim() || null,
        // admin_user_id は明示的に未設定 (トリガー制約回避のため NULL)
        admin_user_id: null,
      }
      const { error } = await supabase
        .from('organizations')
        .insert(payload as never)
        .select()
        .single<Organization>()
      if (error) throw error
      await onCreated()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '組織の作成に失敗しました'
      setLocalError(msg)
      onError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-lg rounded-xl shadow-xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-emerald-600" />
            <h3 className="text-base font-semibold">申込を承認して組織を作成</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 space-y-2">
          <div className="text-[11px] text-slate-500 leading-relaxed bg-slate-50 border rounded p-2">
            申込内容を元に組織を新規作成します。管理者は未設定のまま作成され、
            申込者がユーザー登録した後にユーザー管理画面で組織へ紐付け、
            組織管理画面で管理者を指定してください。承認完了で申込のステータスは
            自動的に「完了」になります。
          </div>
          <FormRow label="組織名 *">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="代表者">
            <input
              type="text"
              value={representative}
              onChange={(e) => setRepresentative(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="電話番号">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="郵便番号">
            <input
              type="text"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              placeholder="例: 999-0000"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="住所">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="プラン">
            <input
              type="text"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </FormRow>
          <FormRow label="ユーザー数">
            <input
              type="number"
              min={0}
              value={userCountLimit}
              onChange={(e) => setUserCountLimit(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 border rounded text-sm text-right"
            />
          </FormRow>
          <FormRow label="メモ" alignTop>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 border rounded text-sm h-16"
            />
          </FormRow>
        </div>
        {localError && (
          <div className="px-4 py-2 border-t bg-red-50 text-xs text-red-700 shrink-0">
            {localError}
          </div>
        )}
        <div className="px-4 py-3 border-t shrink-0 flex gap-2">
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            組織を作成
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 px-4 py-2.5 text-sm border rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

function FormRow({
  label,
  children,
  alignTop,
}: {
  label: string
  children: React.ReactNode
  alignTop?: boolean
}) {
  return (
    <div className={`flex ${alignTop ? 'items-start' : 'items-center'} gap-2`}>
      <span
        className={`text-xs text-slate-500 shrink-0 w-20 ${alignTop ? 'pt-1.5' : ''}`}
      >
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
