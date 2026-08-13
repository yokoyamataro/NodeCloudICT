// /admin/organizations
//   組織マスタ (organizations) と、選択組織のメンバー (organization_members) を
//   Master-Detail レイアウトで統合管理する画面。
//   旧 /admin/users は本画面に統合済み (App.tsx でリダイレクト)。
//
// レイアウト:
//   [サイトオーナー]
//     ┌──────────────┬─────────────────────────────┐
//     │ 組織一覧      │ 上半: 選択組織の情報フォーム │
//     │ (検索 + 一覧) │  ─────────────────────────  │
//     │ [+新規]      │ 下半: OrgMembersView         │
//     └──────────────┴─────────────────────────────┘
//   [組織 admin (非サイトオーナー)]
//     ┌─────────────────────────────┐
//     │ 上半: 自組織の情報 (読取専用) │
//     │  ─────────────────────────  │
//     │ 下半: OrgMembersView         │
//     └─────────────────────────────┘
//
// 権限:
//   - 組織情報の編集 / 削除 / 新規作成: サイトオーナーのみ
//   - メンバー一覧・招待・役割変更・削除: 下部 OrgMembersView に委譲
//     (中で is_site_owner or is_admin_of_org を判定)

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  Loader2,
  RefreshCw,
  ArrowLeft,
  Building2,
  Plus,
  Save,
  Trash2,
  Search,
  X,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { Organization } from '@/types/database'
import { OrgMembersView } from './OrgMembersView'
import { OrgSurveyorsView } from './OrgSurveyorsView'
import { OrgReportSnippetsView } from './OrgReportSnippetsView'

// --- 組織情報フォームのドラフト型 ---
interface OrgDraft {
  name: string
  postal_code: string
  phone: string
  address: string
  representative: string
  user_count_limit: string
  plan: string
  /** 利用期限 (YYYY-MM-DD、空文字は無期限)。サイトオーナーのみ設定可 */
  expires_at: string
  note: string
}

const EMPTY_ORG_DRAFT: OrgDraft = {
  name: '',
  postal_code: '',
  phone: '',
  address: '',
  representative: '',
  user_count_limit: '',
  plan: '',
  expires_at: '',
  note: '',
}

function toDraft(o: Organization): OrgDraft {
  return {
    name: o.name,
    postal_code: o.postal_code ?? '',
    phone: o.phone ?? '',
    address: o.address ?? '',
    representative: o.representative ?? '',
    user_count_limit: o.user_count_limit == null ? '' : String(o.user_count_limit),
    plan: o.plan ?? '',
    expires_at: o.expires_at ? o.expires_at.slice(0, 10) : '',
    note: o.note ?? '',
  }
}

function toPayload(d: OrgDraft) {
  let limit: number | null = null
  if (d.user_count_limit.trim() !== '') {
    const n = Number(d.user_count_limit)
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error('ユーザー数上限は 0 以上の整数で指定してください')
    }
    limit = n
  }
  // 期限は YYYY-MM-DD → その日の 23:59:59 JST (= 14:59:59 UTC) までを許容する。
  // (「7/31 まで」と入れたら 7/31 中は使えるようにする)
  let expiresAt: string | null = null
  const raw = d.expires_at.trim()
  if (raw !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error('利用期限は YYYY-MM-DD 形式で入力してください')
    }
    // "2026-07-31" → "2026-07-31T14:59:59Z" (= JST 23:59:59)
    expiresAt = `${raw}T14:59:59Z`
  }
  return {
    name: d.name.trim(),
    postal_code: d.postal_code.trim() || null,
    phone: d.phone.trim() || null,
    address: d.address.trim() || null,
    representative: d.representative.trim() || null,
    user_count_limit: limit,
    plan: d.plan.trim() || null,
    expires_at: expiresAt,
    note: d.note.trim() || null,
  }
}

// admin RPC 用の軽い型キャストラッパ
async function callRpc<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  return (await supabase.rpc(fn as never, (args ?? {}) as never)) as unknown as {
    data: T | null
    error: { message: string } | null
  }
}

interface AdminOrgRow {
  organization_id: string
  organization_name: string
}

// ============================================================
// メインコンポーネント
// ============================================================
export function AdminOrganizationsPage() {
  const { user } = useAuth()
  const siteOwner = isAdmin(user?.email)
  const [myAdminOrgs, setMyAdminOrgs] = useState<AdminOrgRow[] | null>(null)

  // 自分が admin である組織一覧を取得 (非サイトオーナー用)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      const { data } = await callRpc<AdminOrgRow[]>('list_my_admin_org_ids')
      if (!cancelled) setMyAdminOrgs((data ?? []) as AdminOrgRow[])
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  // アクセス制御
  if (!siteOwner) {
    if (myAdminOrgs === null) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
        </div>
      )
    }
    if (myAdminOrgs.length === 0) return <Navigate to="/" replace />
    return <OrgAdminUnifiedView adminOrgs={myAdminOrgs} />
  }

  return <SiteOwnerUnifiedView />
}

// ============================================================
// サイトオーナー用ビュー
// ============================================================
function SiteOwnerUnifiedView() {
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [showNewDialog, setShowNewDialog] = useState(false)

  const fetchOrgs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('*')
        .order('name')
      if (error) throw error
      const list = (data ?? []) as Organization[]
      setOrgs(list)
      // 選択維持 / 初回は先頭
      setSelectedOrgId((prev) => prev ?? list[0]?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchOrgs()
  }, [fetchOrgs])

  const filteredOrgs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter((o) =>
      [o.name, o.representative, o.address, o.note]
        .filter((s): s is string => typeof s === 'string')
        .some((s) => s.toLowerCase().includes(q)),
    )
  }, [orgs, search])

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId) ?? null

  const handleOrgUpdated = (updated: Organization) => {
    setOrgs((prev) =>
      prev
        .map((o) => (o.id === updated.id ? updated : o))
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  }
  const handleOrgDeleted = (deletedId: string) => {
    setOrgs((prev) => prev.filter((o) => o.id !== deletedId))
    setSelectedOrgId((prev) => (prev === deletedId ? null : prev))
  }
  const handleOrgCreated = (created: Organization) => {
    setOrgs((prev) =>
      [created, ...prev].sort((a, b) => a.name.localeCompare(b.name)),
    )
    setSelectedOrgId(created.id)
    setShowNewDialog(false)
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link
          to="/"
          className="p-1.5 hover:bg-slate-100 rounded"
          title="トップへ"
        >
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <Building2 className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">組織・メンバー管理</h1>
        <Link
          to="/admin/signups"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          申込管理
        </Link>
        <button
          onClick={fetchOrgs}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          再取得
        </button>
      </header>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* 左サイドバー: 組織一覧 + 検索 + 新規 */}
        <aside className="w-64 border-r bg-white flex flex-col flex-shrink-0">
          <div className="p-2 border-b space-y-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="組織名で検索"
                className="w-full pl-7 pr-2 py-1.5 text-xs border rounded"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700"
                  aria-label="検索クリア"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowNewDialog(true)}
              className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              <Plus className="h-3 w-3" />
              新規組織
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {loading && orgs.length === 0 ? (
              <div className="p-4 flex items-center justify-center text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                読込中…
              </div>
            ) : filteredOrgs.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                {search ? '該当なし' : '組織がまだありません'}
              </div>
            ) : (
              <ul>
                {filteredOrgs.map((o) => (
                  <li key={o.id}>
                    <button
                      onClick={() => setSelectedOrgId(o.id)}
                      className={`w-full text-left px-3 py-2 text-sm border-b hover:bg-slate-50 ${
                        selectedOrgId === o.id
                          ? 'bg-blue-50 text-blue-800 font-medium border-l-2 border-l-blue-600'
                          : ''
                      }`}
                    >
                      <div className="truncate">{o.name}</div>
                      {o.representative && (
                        <div className="text-[10px] text-slate-500 truncate">
                          {o.representative}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-2 py-1.5 border-t text-[10px] text-slate-400 text-center">
            {filteredOrgs.length} / {orgs.length} 組織
          </div>
        </aside>

        {/* 右エリア: 上=組織情報 / 下=メンバー */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {selectedOrg ? (
            <>
              <OrgInfoForm
                key={selectedOrg.id}
                org={selectedOrg}
                editable={true}
                siteOwner={true}
                onSaved={handleOrgUpdated}
                onDeleted={handleOrgDeleted}
              />
              <div className="flex-1 min-h-0 overflow-hidden border-t bg-white flex flex-col">
                <OrgSubTabs
                  key={selectedOrg.id}
                  organizationId={selectedOrg.id}
                  organizationName={selectedOrg.name}
                  userCountLimit={selectedOrg.user_count_limit}
                  expiresAt={selectedOrg.expires_at}
                  editable={true}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
              左の一覧から組織を選択してください
            </div>
          )}
        </main>
      </div>

      {showNewDialog && (
        <NewOrgDialog
          onClose={() => setShowNewDialog(false)}
          onCreated={handleOrgCreated}
        />
      )}
    </div>
  )
}

// ============================================================
// 組織 admin (非サイトオーナー) 用ビュー
// ============================================================
function OrgAdminUnifiedView({ adminOrgs }: { adminOrgs: AdminOrgRow[] }) {
  const [activeOrgId, setActiveOrgId] = useState<string>(
    adminOrgs[0].organization_id,
  )
  const activeOrg = adminOrgs.find((o) => o.organization_id === activeOrgId) ??
    adminOrgs[0]

  const [org, setOrg] = useState<Organization | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const { data } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', activeOrg.organization_id)
        .maybeSingle<Organization>()
      if (!cancelled) {
        setOrg(data ?? null)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeOrg.organization_id])

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link
          to="/"
          className="p-1.5 hover:bg-slate-100 rounded"
          title="トップへ"
        >
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <Building2 className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">組織・メンバー管理</h1>
        {adminOrgs.length > 1 && (
          <select
            value={activeOrgId}
            onChange={(e) => setActiveOrgId(e.target.value)}
            className="px-2 py-1 text-sm border rounded bg-white"
          >
            {adminOrgs.map((o) => (
              <option key={o.organization_id} value={o.organization_id}>
                {o.organization_name}
              </option>
            ))}
          </select>
        )}
      </header>

      <div className="flex-1 flex flex-col overflow-hidden">
        {loading || !org ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          </div>
        ) : (
          <>
            <OrgInfoForm org={org} editable={false} />
            <div className="flex-1 min-h-0 overflow-hidden border-t bg-white flex flex-col">
              <OrgSubTabs
                organizationId={org.id}
                organizationName={org.name}
                userCountLimit={org.user_count_limit}
                expiresAt={org.expires_at}
                editable={true}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================
// 組織の下部タブ (メンバー / 調査士セット / 定型文)
// ============================================================
type OrgSubTab = 'members' | 'surveyors' | 'snippets'

function OrgSubTabs({
  organizationId,
  organizationName,
  userCountLimit,
  expiresAt,
  editable,
}: {
  organizationId: string
  organizationName: string
  userCountLimit?: number | null
  expiresAt?: string | null
  editable: boolean
}) {
  const [tab, setTab] = useState<OrgSubTab>('members')
  return (
    <>
      <div className="flex gap-0 border-b bg-slate-50">
        {(
          [
            { key: 'members', label: 'メンバー' },
            { key: 'surveyors', label: '土地家屋調査士' },
            { key: 'snippets', label: '定型文' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-600 text-blue-700 font-medium bg-white'
                : 'border-transparent text-slate-600 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'members' && (
        <OrgMembersView
          organizationId={organizationId}
          organizationName={organizationName}
          userCountLimit={userCountLimit}
          expiresAt={expiresAt}
        />
      )}
      {tab === 'surveyors' && (
        <OrgSurveyorsView organizationId={organizationId} editable={editable} />
      )}
      {tab === 'snippets' && (
        <OrgReportSnippetsView organizationId={organizationId} editable={editable} />
      )}
    </>
  )
}

// ============================================================
// 組織情報フォーム (上半)
// ============================================================
function OrgInfoForm({
  org,
  editable,
  siteOwner = false,
  onSaved,
  onDeleted,
}: {
  org: Organization
  editable: boolean
  /** サイトオーナー限定フィールド (利用期限) を活性化するか */
  siteOwner?: boolean
  onSaved?: (org: Organization) => void
  onDeleted?: (id: string) => void
}) {
  const [draft, setDraft] = useState<OrgDraft>(() => toDraft(org))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // 別の組織が選ばれたら draft をリセット
  useEffect(() => {
    setDraft(toDraft(org))
    setError(null)
    setMessage(null)
  }, [org.id, org.name, org.updated_at, org])

  const dirty = useMemo(() => {
    const cur = toDraft(org)
    return (Object.keys(draft) as (keyof OrgDraft)[]).some(
      (k) => draft[k] !== cur[k],
    )
  }, [draft, org])

  const handleSave = async () => {
    setError(null)
    setMessage(null)
    if (!draft.name.trim()) {
      setError('組織名は必須です')
      return
    }
    setSaving(true)
    try {
      const payload = toPayload(draft)
      const { data, error } = await supabase
        .from('organizations')
        .update(payload as never)
        .eq('id', org.id)
        .select('*')
        .single()
      if (error) throw error
      const updated = data as Organization
      setMessage('保存しました')
      onSaved?.(updated)
    } catch (err) {
      // Supabase の PostgrestError は Error インスタンスとは限らないので
      // message / details / hint / code を全部拾って表示する
      console.error('[AdminOrganizationsPage] save failed', err)
      const parts: string[] = []
      if (err instanceof Error) {
        parts.push(err.message)
      } else if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>
        if (typeof obj.message === 'string') parts.push(obj.message)
        if (typeof obj.details === 'string') parts.push(obj.details)
        if (typeof obj.hint === 'string') parts.push(`hint: ${obj.hint}`)
        if (typeof obj.code === 'string') parts.push(`(${obj.code})`)
      }
      setError(parts.length ? parts.join(' — ') : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (
      !confirm(
        `「${org.name}」を削除します。\n\n・所属メンバー (organization_members) は連鎖削除\n・profiles.organization_id は NULL に\n\nよろしいですか?`,
      )
    ) {
      return
    }
    setDeleting(true)
    setError(null)
    try {
      const { error } = await supabase
        .from('organizations')
        .delete()
        .eq('id', org.id)
      if (error) throw error
      onDeleted?.(org.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
      setDeleting(false)
    }
  }

  const inputClass =
    'w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-600'

  return (
    <div className="p-4 bg-white space-y-3 overflow-auto max-h-[50vh]">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">組織情報</h2>
        {!editable && (
          <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
            表示のみ
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {message && (
            <span className="text-xs text-emerald-700">{message}</span>
          )}
          {error && <span className="text-xs text-red-700">{error}</span>}
          {editable && (
            <>
              <button
                onClick={handleDelete}
                disabled={deleting || saving}
                className="flex items-center gap-1 px-2 py-1 text-xs text-red-700 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50"
                title="この組織を削除"
              >
                {deleting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                削除
              </button>
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                className={`flex items-center gap-1 px-3 py-1 text-xs rounded ${
                  dirty
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                } disabled:opacity-50`}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                保存
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <FormField label="組織名 *" span={2}>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            disabled={!editable}
            className={inputClass}
          />
        </FormField>
        <FormField label="代表者">
          <input
            type="text"
            value={draft.representative}
            onChange={(e) =>
              setDraft((d) => ({ ...d, representative: e.target.value }))
            }
            disabled={!editable}
            className={inputClass}
          />
        </FormField>
        <FormField label="電話番号">
          <input
            type="text"
            value={draft.phone}
            onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            disabled={!editable}
            className={inputClass}
          />
        </FormField>
        <FormField label="郵便番号">
          <input
            type="text"
            value={draft.postal_code}
            onChange={(e) =>
              setDraft((d) => ({ ...d, postal_code: e.target.value }))
            }
            disabled={!editable}
            className={inputClass}
          />
        </FormField>
        <FormField label="住所" span={3}>
          <input
            type="text"
            value={draft.address}
            onChange={(e) =>
              setDraft((d) => ({ ...d, address: e.target.value }))
            }
            disabled={!editable}
            className={inputClass}
          />
        </FormField>
        <FormField label="プラン">
          <input
            type="text"
            value={draft.plan}
            onChange={(e) => setDraft((d) => ({ ...d, plan: e.target.value }))}
            disabled={!editable}
            className={inputClass}
            placeholder="例: 標準 / プロ / エンタープライズ"
          />
        </FormField>
        <FormField label="ユーザー数上限">
          <input
            type="text"
            inputMode="numeric"
            value={draft.user_count_limit}
            onChange={(e) =>
              setDraft((d) => ({ ...d, user_count_limit: e.target.value }))
            }
            disabled={!editable}
            className={inputClass}
            placeholder="(制限なし)"
          />
        </FormField>
        <FormField label={siteOwner ? '利用期限' : '利用期限 (site owner のみ)'}>
          <input
            type="date"
            value={draft.expires_at}
            onChange={(e) =>
              setDraft((d) => ({ ...d, expires_at: e.target.value }))
            }
            disabled={!editable || !siteOwner}
            className={inputClass}
            placeholder="(無期限)"
          />
          {draft.expires_at && (
            <div className="mt-0.5 text-[10px] text-slate-500">
              {(() => {
                const d = new Date(`${draft.expires_at}T14:59:59Z`)
                const now = new Date()
                const days = Math.ceil((d.getTime() - now.getTime()) / 86400000)
                if (days < 0) return <span className="text-red-600 font-medium">期限切れ ({-days} 日経過)</span>
                if (days === 0) return <span className="text-amber-700">本日まで</span>
                return <span>残 {days} 日</span>
              })()}
            </div>
          )}
        </FormField>
        <FormField label="メモ" span={3}>
          <textarea
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            disabled={!editable}
            rows={2}
            className={inputClass + ' resize-y'}
          />
        </FormField>
      </div>
      <div className="text-[10px] text-slate-400 font-mono">
        organization_id: {org.id} / 登録日:{' '}
        {new Date(org.created_at).toLocaleDateString('ja-JP')}
      </div>
    </div>
  )
}

function FormField({
  label,
  children,
  span = 1,
}: {
  label: string
  children: React.ReactNode
  span?: 1 | 2 | 3
}) {
  const spanClass =
    span === 3
      ? 'sm:col-span-2 lg:col-span-3'
      : span === 2
        ? 'sm:col-span-2'
        : ''
  return (
    <div className={spanClass}>
      <label className="block text-[11px] text-slate-500 mb-0.5">{label}</label>
      {children}
    </div>
  )
}

// ============================================================
// 新規組織作成ダイアログ
// ============================================================
function NewOrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (org: Organization) => void
}) {
  const [draft, setDraft] = useState<OrgDraft>(EMPTY_ORG_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    setError(null)
    if (!draft.name.trim()) {
      setError('組織名は必須です')
      return
    }
    setBusy(true)
    try {
      const payload = toPayload(draft)
      const { data, error } = await supabase
        .from('organizations')
        .insert(payload as never)
        .select('*')
        .single()
      if (error) throw error
      onCreated(data as Organization)
    } catch (err) {
      console.error('[AdminOrganizationsPage] create failed', err)
      const parts: string[] = []
      if (err instanceof Error) {
        parts.push(err.message)
      } else if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>
        if (typeof obj.message === 'string') parts.push(obj.message)
        if (typeof obj.details === 'string') parts.push(obj.details)
        if (typeof obj.hint === 'string') parts.push(`hint: ${obj.hint}`)
        if (typeof obj.code === 'string') parts.push(`(${obj.code})`)
      }
      setError(parts.length ? parts.join(' — ') : '作成に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold">新規組織</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && (
          <div className="mb-3 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
            {error}
          </div>
        )}
        <div className="space-y-2">
          <FormField label="組織名 *">
            <input
              type="text"
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
              className={inputClass}
              autoFocus
            />
          </FormField>
          <FormField label="代表者">
            <input
              type="text"
              value={draft.representative}
              onChange={(e) =>
                setDraft((d) => ({ ...d, representative: e.target.value }))
              }
              className={inputClass}
            />
          </FormField>
          <FormField label="電話番号">
            <input
              type="text"
              value={draft.phone}
              onChange={(e) =>
                setDraft((d) => ({ ...d, phone: e.target.value }))
              }
              className={inputClass}
            />
          </FormField>
          <FormField label="住所">
            <input
              type="text"
              value={draft.address}
              onChange={(e) =>
                setDraft((d) => ({ ...d, address: e.target.value }))
              }
              className={inputClass}
            />
          </FormField>
          <FormField label="プラン">
            <input
              type="text"
              value={draft.plan}
              onChange={(e) =>
                setDraft((d) => ({ ...d, plan: e.target.value }))
              }
              className={inputClass}
            />
          </FormField>
          <FormField label="メモ">
            <textarea
              value={draft.note}
              onChange={(e) =>
                setDraft((d) => ({ ...d, note: e.target.value }))
              }
              rows={2}
              className={inputClass + ' resize-y'}
            />
          </FormField>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleCreate}
            disabled={busy || !draft.name.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            作成
          </button>
        </div>
      </div>
    </div>
  )
}
