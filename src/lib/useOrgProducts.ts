// 現在ログイン中のユーザーが所属する組織の「契約中の製品」を返す hook。
//
// 戻り値:
//   { products: Set<OrgProduct>, loading: boolean }
//   products はサーバから引いた「期限内 (expires_at IS NULL または未来)」の
//   organization_products 行の product 列を Set にしたもの。
//   サイトオーナーは全製品を常時 true にしてほしいので Set('cadastral','civil','mobility') を返す。
//
// キャッシュ:
//   組織 ID が変わるたびに 1 回だけ引く軽量な useEffect ベース。
//   契約の変更頻度は極めて低いのでリアクティブ購読までは不要。
//
// 将来:
//   販売系画面 (契約更新 UI) から書き込みが発生したときは、そこから
//   fetch() を呼び直せば良い。返り値に refetch を追加しても良い。

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import type { OrgProduct } from '@/types/database'

const ALL_PRODUCTS: OrgProduct[] = ['cadastral', 'civil', 'mobility']

interface State {
  products: Set<OrgProduct>
  loading: boolean
}

export function useOrgProducts(): State {
  const { user, profile } = useAuth()
  const [state, setState] = useState<State>({
    products: new Set(),
    loading: true,
  })

  useEffect(() => {
    // サイトオーナーは無条件に全製品を持っている扱い
    if (isAdmin(user?.email)) {
      setState({ products: new Set(ALL_PRODUCTS), loading: false })
      return
    }
    const orgId = profile?.organization_id
    if (!user || !orgId) {
      setState({ products: new Set(), loading: false })
      return
    }

    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    ;(async () => {
      const { data, error } = await supabase
        .from('organization_products')
        .select('product, expires_at')
        .eq('organization_id', orgId)
      if (cancelled) return
      if (error) {
        console.warn('[useOrgProducts] fetch failed:', error.message)
        setState({ products: new Set(), loading: false })
        return
      }
      const now = Date.now()
      const active = new Set<OrgProduct>()
      for (const row of (data ?? []) as { product: OrgProduct; expires_at: string | null }[]) {
        if (row.expires_at == null || new Date(row.expires_at).getTime() >= now) {
          active.add(row.product)
        }
      }
      setState({ products: active, loading: false })
    })()

    return () => {
      cancelled = true
    }
  }, [user, profile?.organization_id])

  return state
}
