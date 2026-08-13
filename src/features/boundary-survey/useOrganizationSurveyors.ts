// ログイン中ユーザーが所属する組織の 土地家屋調査士 一覧を返すフック。
//
// 使用箇所: 土地調査報告書 の ヘッダ (調査士セット選択)
//
// 組織の判定: profiles.organization_id を優先し、
//   欠損時は organization_members から先頭 1 件を採用する。
//   (profiles.organization_id は 欠損することがある — メモリ参照)

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export interface OrgSurveyor {
  id: string
  name: string
  registrationNo: string | null
  officeName: string | null
  phoneNo: string | null
}

interface Row {
  id: string
  organization_id: string
  name: string
  registration_no: string | null
  office_name: string | null
  phone_no: string | null
  sort_order: number
}

interface Result {
  surveyors: OrgSurveyor[]
  organizationId: string | null
  loading: boolean
  error: string | null
}

const toSurveyor = (r: Row): OrgSurveyor => ({
  id: r.id,
  name: r.name,
  registrationNo: r.registration_no,
  officeName: r.office_name,
  phoneNo: r.phone_no,
})

export function useOrganizationSurveyors(): Result {
  const { user, profile } = useAuth()
  const [surveyors, setSurveyors] = useState<OrgSurveyor[]>([])
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setSurveyors([])
      setOrganizationId(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)

      // 1) organization_id を決定
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
        setSurveyors([])
        setLoading(false)
        return
      }

      // 2) その組織の surveyors を取得
      const { data, error: err } = await supabase
        .from('organization_surveyors')
        .select('*')
        .eq('organization_id', orgId)
        .order('sort_order')
        .order('created_at')
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setSurveyors(((data ?? []) as Row[]).map(toSurveyor))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [user, profile?.organization_id])

  return { surveyors, organizationId, loading, error }
}
