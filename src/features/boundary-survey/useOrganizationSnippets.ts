// 組織の定型文 (organization_report_snippets) を カテゴリ別に取得するフック。
// 06 原本確認結果 / 09 基本三角点測量できない理由 / 10 補足・特記事項 で使う。

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { SnippetCategory } from '@/features/admin/OrgReportSnippetsView'

export interface OrgSnippet {
  id: string
  category: SnippetCategory
  label: string
  body: string
}

interface Row {
  id: string
  organization_id: string
  category: SnippetCategory
  label: string
  body: string
  sort_order: number
}

interface Result {
  snippets: OrgSnippet[]
  organizationId: string | null
  loading: boolean
  error: string | null
}

export function useOrganizationSnippets(category: SnippetCategory): Result {
  const { user, profile } = useAuth()
  const [snippets, setSnippets] = useState<OrgSnippet[]>([])
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setSnippets([])
      setOrganizationId(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)

      let orgId = profile?.organization_id ?? null
      if (!orgId) {
        const { data: memberRow } = await supabase
          .from('organization_members')
          .select('organization_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle<{ organization_id: string }>()
        orgId = memberRow?.organization_id ?? null
      }
      if (cancelled) return
      setOrganizationId(orgId)

      if (!orgId) {
        setSnippets([])
        setLoading(false)
        return
      }

      const { data, error: err } = await supabase
        .from('organization_report_snippets')
        .select('*')
        .eq('organization_id', orgId)
        .eq('category', category)
        .order('sort_order')
        .order('created_at')
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setSnippets(
        ((data ?? []) as Row[]).map((r) => ({
          id: r.id,
          category: r.category,
          label: r.label,
          body: r.body,
        })),
      )
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [user, profile?.organization_id, category])

  return { snippets, organizationId, loading, error }
}
