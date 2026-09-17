// 設定 > 土地家屋調査士設定。
//
// 調査士 (氏名 / 登録番号 / 所属会 / 電話) と、報告書 の 定型文。 どちら も
// 組織 に ぶら下がる 共通 の 設定 な ので、直せば 組織 の 全員 に 効く。
//
// 元 は 管理者 の 組織画面 の タブ に あった が、使う のは 現場 の 側 な ので
// 工区 の 設定 に 移した。 中身 の 部品 は そのまま 使い回す。
//
// 直せる のは 組織 の 管理者 だけ (RLS の is_admin_of_org)。 それ以外 は
// 見る だけ に して おく。

import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { OrgSurveyorsView } from '@/features/admin/OrgSurveyorsView'
import { OrgReportSnippetsView } from '@/features/admin/OrgReportSnippetsView'

export function SurveyorSettingsPage() {
  const { user, profile, organizationName, isOrgAdmin } = useAuth()
  // profiles.organization_id が あれば それ、 無ければ 会員表 で 補う
  const known = profile?.organization_id ?? null
  const [fetched, setFetched] = useState<{ id: string | null } | null>(null)
  const orgId = known ?? fetched?.id ?? null
  const loading = user != null && known == null && fetched == null

  useEffect(() => {
    if (!user || known) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle<{ organization_id: string }>()
      if (!cancelled) setFetched({ id: data?.organization_id ?? null })
    })()
    return () => {
      cancelled = true
    }
  }, [user, known])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        読み込み中…
      </div>
    )
  }

  if (!orgId) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center text-sm text-slate-500">
        所属している組織がありません。
        <br />
        <span className="text-xs">組織に招待されると、この設定が使えます。</span>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b bg-white">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold">土地家屋調査士設定</h2>
          {organizationName && (
            <span className="text-xs text-slate-500">{organizationName}</span>
          )}
          {!isOrgAdmin && (
            <span className="ml-2 px-2 py-0.5 rounded bg-slate-100 text-[11px] text-slate-600">
              閲覧のみ（変更は組織の管理者）
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          所属組織の共通設定です。ここでの変更は組織のメンバー全員に反映されます。
        </p>
      </div>

      <div className="p-4 space-y-4 max-w-5xl">
        <div className="border rounded bg-white">
          <OrgSurveyorsView organizationId={orgId} editable={isOrgAdmin} />
        </div>
        <div className="border rounded bg-white">
          <OrgReportSnippetsView organizationId={orgId} editable={isOrgAdmin} />
        </div>
      </div>
    </div>
  )
}
