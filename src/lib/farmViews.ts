// 工区の 閲覧履歴 (farm_views)。
//
// 工区を 開く たびに 自分の 行を 更新し、工区設定で 「最終閲覧日 / 閲覧者」を
// 出す ために 使う。1 工区 × 1 ユーザー で 1 行 だけ 持ち、履歴は 積まない。

import { supabase } from './supabase'
import { errorMessage } from './farmFiles'

export interface FarmViewRow {
  userId: string
  userName: string | null
  viewedAt: string
}

/** 自分が この 工区を 見た ことを 記録する。失敗しても 画面は 止めない */
export async function touchFarmView(farmId: string): Promise<void> {
  try {
    const { data: u } = await supabase.auth.getUser()
    const userId = u.user?.id
    if (!userId) return
    await supabase
      .from('farm_views')
      .upsert(
        { farm_id: farmId, user_id: userId, viewed_at: new Date().toISOString() } as never,
        { onConflict: 'farm_id,user_id' },
      )
  } catch (e) {
    // テーブル 未作成 (マイグレーション 未実行) でも 動作を 止めない
    console.warn('[farm view]', errorMessage(e))
  }
}

/** 新しい順の 閲覧履歴。氏名は profiles から 引く */
export async function listFarmViews(farmId: string, limit = 10): Promise<FarmViewRow[]> {
  const { data, error } = await supabase
    .from('farm_views')
    .select('user_id, viewed_at')
    .eq('farm_id', farmId)
    .order('viewed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  const rows = (data ?? []) as unknown as { user_id: string; viewed_at: string }[]
  if (rows.length === 0) return []
  const names = await fetchUserNames(rows.map((r) => r.user_id))
  return rows.map((r) => ({
    userId: r.user_id,
    userName: names.get(r.user_id) ?? null,
    viewedAt: r.viewed_at,
  }))
}

/** user_id → 氏名。取れない ぶんは 落とす (呼び側で null 表示) */
export async function fetchUserNames(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = Array.from(new Set(userIds)).filter(Boolean)
  if (ids.length === 0) return out
  try {
    const { data } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', ids)
    for (const r of (data ?? []) as unknown as { user_id: string; full_name: string | null }[]) {
      if (r.full_name) out.set(r.user_id, r.full_name)
    }
  } catch {
    /* 名前が 引けなくても 日時は 出す */
  }
  return out
}
