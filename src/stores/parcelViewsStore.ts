// 地番 の 閲覧履歴 の 軽い キャッシュ。
//
// 地番一覧 の 「表示履歴」 列 は 全行 で 参照 する ので、行 ごと に
// fetch は 出来ない。 工区 を 開く タイミング で 全 筆 の 閲覧履歴 を
// 一括 取得 し、work_area_id → 履歴配列 の Map に 入れる。
// 選択 で touchParcelView を 呼んだ 後 は ローカル でも 最新化 する
// (再フェッチ を 待たない ため)。

import { create } from 'zustand'
import {
  listParcelViewsForFarm,
  type ParcelViewRow,
  type ParcelViewsByWorkAreaId,
} from '@/lib/parcelViews'
import { supabase } from '@/lib/supabase'
import { fetchUserNames } from '@/lib/farmViews'

interface State {
  /** 直近 fetch した farm。 別 工区 に 移ったら 破棄。 */
  loadedFarmId: string | null
  /** work_area_id → 新しい順 の 閲覧履歴 */
  byWorkAreaId: ParcelViewsByWorkAreaId
  loading: boolean
  fetchForWorkAreas: (farmId: string, workAreaIds: string[]) => Promise<void>
  /** touch 後 の 楽観 更新: 自分 の 行 を 先頭 に 差し込む */
  bumpLocal: (workAreaId: string) => Promise<void>
  clear: () => void
}

export const useParcelViewsStore = create<State>()((set, get) => ({
  loadedFarmId: null,
  byWorkAreaId: new Map(),
  loading: false,
  fetchForWorkAreas: async (farmId, workAreaIds) => {
    if (get().loadedFarmId === farmId) return
    set({ loading: true })
    try {
      const m = await listParcelViewsForFarm(workAreaIds)
      set({ byWorkAreaId: m, loadedFarmId: farmId, loading: false })
    } catch {
      set({ byWorkAreaId: new Map(), loadedFarmId: farmId, loading: false })
    }
  },
  bumpLocal: async (workAreaId) => {
    const { data: u } = await supabase.auth.getUser()
    const userId = u.user?.id
    if (!userId) return
    const names = await fetchUserNames([userId])
    const now = new Date().toISOString()
    const newRow: ParcelViewRow = {
      userId,
      userName: names.get(userId) ?? null,
      viewedAt: now,
    }
    set((s) => {
      const next = new Map(s.byWorkAreaId)
      const arr = (next.get(workAreaId) ?? []).filter((r) => r.userId !== userId)
      arr.unshift(newRow)
      next.set(workAreaId, arr)
      return { byWorkAreaId: next }
    })
  },
  clear: () =>
    set({ loadedFarmId: null, byWorkAreaId: new Map(), loading: false }),
}))
