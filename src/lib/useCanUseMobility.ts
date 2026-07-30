// モビリティ機能 (現在地・走行ログ) の利用可否を判定する 2 種類の hook。
//
// useCanUseMobility  — ドライバー画面を開ける (組織に所属していれば OK)
// useCanManageMobility — 管理画面を開ける (サイトオーナー or 組織 admin)
//
// 将来 organization_products テーブルで契約管理を厳格化する場合は、
// ここに `has_org_product(orgId, 'mobility')` の OR 条件を足すだけで済むよう
// 判定を 1 か所に集約している。

import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'

/**
 * ドライバー画面 (自分の運転を送信する画面) を開けるか。
 * 組織に所属していれば誰でも OK (サイトオーナーは無条件で true)。
 */
export function useCanUseMobility(): boolean {
  const { user, profile } = useAuth()
  if (!user) return false
  if (isAdmin(user.email)) return true
  return !!profile?.organization_id
}

/**
 * 管理画面 (フリート地図、車両マスタ、割当管理、運行ログ等) を開けるか。
 * サイトオーナー、または組織 admin のみ。
 */
export function useCanManageMobility(): boolean {
  const { user, isOrgAdmin } = useAuth()
  if (!user) return false
  if (isAdmin(user.email)) return true
  return isOrgAdmin
}
