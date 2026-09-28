// 地番 の 閲覧履歴 (parcel_views)。
//
// 筆 を 選ぶ (地図 の 筆 ポリゴン / 一覧行 の クリック) たび に 自分 の 行 を
// upsert し、地番一覧 の 「表示履歴」 列 で 最終 閲覧者・時刻 を 出す。
// 履歴 は 1 筆 × 1 ユーザー で 1 行 だけ (最新 の 閲覧 時刻 のみ 残す)。

import { supabase } from './supabase'
import { fetchUserNames } from './farmViews'

export interface ParcelViewRow {
  userId: string
  userName: string | null
  viewedAt: string
}

export type ParcelViewsByWorkAreaId = Map<string, ParcelViewRow[]>

/**
 * 自分 が この 筆 (work_area) を 見た ことを 記録 する。
 * 失敗しても 画面 は 止めない (テーブル 未作成 / RLS 失敗 でも 続行)。
 */
export async function touchParcelView(workAreaId: string): Promise<void> {
  try {
    const { data: u } = await supabase.auth.getUser()
    const userId = u.user?.id
    if (!userId) return
    await supabase
      .from('parcel_views')
      .upsert(
        {
          work_area_id: workAreaId,
          user_id: userId,
          viewed_at: new Date().toISOString(),
        } as never,
        { onConflict: 'work_area_id,user_id' },
      )
  } catch {
    /* 未マイグレーション / RLS で 弾かれて も 続行 */
  }
}

/**
 * 工区 に 属す 全 筆 の 閲覧履歴 を 一括 取得 する。
 * work_area_id → 新しい順 の 閲覧履歴 (先頭 が 最終 閲覧者)。
 * 名前 は profiles.full_name から 引く。
 */
export async function listParcelViewsForFarm(
  workAreaIds: string[],
): Promise<ParcelViewsByWorkAreaId> {
  const out: ParcelViewsByWorkAreaId = new Map()
  if (workAreaIds.length === 0) return out
  try {
    // in() は 既定 1000 行/req なので 大量 の 工区 で は 切って 呼ぶ。
    // 現状 の 上限 (地番 上限 = 数千) なら 1 バッチ で 収まる ので 単発。
    const { data, error } = await supabase
      .from('parcel_views')
      .select('work_area_id, user_id, viewed_at')
      .in('work_area_id', workAreaIds)
      .order('viewed_at', { ascending: false })
    if (error) throw error
    const rows =
      (data ?? []) as unknown as {
        work_area_id: string
        user_id: string
        viewed_at: string
      }[]
    if (rows.length === 0) return out
    const names = await fetchUserNames(rows.map((r) => r.user_id))
    for (const r of rows) {
      const arr = out.get(r.work_area_id) ?? []
      arr.push({
        userId: r.user_id,
        userName: names.get(r.user_id) ?? null,
        viewedAt: r.viewed_at,
      })
      out.set(r.work_area_id, arr)
    }
  } catch {
    /* 未マイグレーション なら 空 */
  }
  return out
}
