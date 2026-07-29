// モビリティ機能 (現在地・走行ログ) を利用できるかの判定 hook。
//
// 現状: サイトオーナー (yokoyama1980@gmail.com) だけに true を返す。
//   モビリティ機能は仕込み中のため、一般ユーザーには存在自体を見せない。
// 将来: organization_products テーブルを追加後、
//   `isAdmin(email) || hasOrgProduct(orgId, 'mobility')` に差し替える。
//   判定を 1 か所に集約しておくと、切替時にここだけ書き換えれば良い。

import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'

export function useCanUseMobility(): boolean {
  const { user } = useAuth()
  return isAdmin(user?.email)
}
