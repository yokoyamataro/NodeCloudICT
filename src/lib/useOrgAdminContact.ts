// 自分 の 所属 組織 の 管理者 (1 人) の 連絡先 を 引く フック。
//
// 「組織管理者 は 1 人」 ルール に 伴い、 organizations.admin_name /
// admin_email / admin_phone を 権威 の ある 連絡先 と する
// (admin_user_id は アプリ の ユーザー と 紐づく 場合 のみ セット)。
// アカウント 削除 / 契約変更 の 申請 を 管理者 経由 で 行う 際 の
// 「誰 に 連絡 すれば 良い か」 を 一般 メンバー 側 に 見せる 用途。

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export interface OrgAdminContact {
  organizationName: string
  adminName: string | null
  adminEmail: string | null
  adminPhone: string | null
}

export function useOrgAdminContact(): {
  loading: boolean
  contact: OrgAdminContact | null
} {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(false)
  const [contact, setContact] = useState<OrgAdminContact | null>(null)

  useEffect(() => {
    const orgId = profile?.organization_id
    if (!orgId) {
      setContact(null)
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const { data } = await supabase
        .from('organizations')
        .select('name, admin_name, admin_email, admin_phone')
        .eq('id', orgId)
        .maybeSingle<{
          name: string
          admin_name: string | null
          admin_email: string | null
          admin_phone: string | null
        }>()
      if (cancelled) return
      if (data) {
        setContact({
          organizationName: data.name,
          adminName: data.admin_name,
          adminEmail: data.admin_email,
          adminPhone: data.admin_phone,
        })
      } else {
        setContact(null)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [profile?.organization_id])

  return { loading, contact }
}
