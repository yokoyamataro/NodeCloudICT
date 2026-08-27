// 圏外で 工事一覧 / 工区一覧が 空になるのを 防ぐ フォールバック。
//
// 一覧は projectListStore / farmStore の 配列から 描かれるが、圏外では
// fetchProjects / fetchFarms が 失敗して 配列が 空のままになり、
// 「ダウンロード済みの 工区を 開く」入口すら 無くなってしまう。
//
// そこで 取得後に 一覧が 空だったら、オフライン保存した スナップショット由来の
// 工事・工区を ストアに 流し込む。ダウンロード済みの ものだけが 並ぶので、
// 開いた先 (MobileStakingPage) も スナップショットで 動く。
//
// オンラインで 正常に 取れた場合は 何もしない (サーバの内容が 常に優先)。

import { useEffect } from 'react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { listCachedFarms, listCachedProjects } from '@/lib/offlineFarmCache'
import type { Project } from '@/types/database'
import type { Farm } from '@/stores/farmStore'

/**
 * 一覧が 空のままなら オフライン保存分で 埋める。
 * loading 中は 判定しない (取得完了を 待ってから 差し込む)。
 */
export function useOfflineListFallback(): void {
  const projectsLen = useProjectListStore((s) => s.projects.length)
  const projectsLoading = useProjectListStore((s) => s.loading)
  const farmsLen = useFarmStore((s) => s.farms.length)
  const farmsLoading = useFarmStore((s) => s.loading)

  useEffect(() => {
    if (projectsLoading || projectsLen > 0) return
    let cancelled = false
    void listCachedProjects().then((rows) => {
      if (cancelled || rows.length === 0) return
      // 取得中に サーバから 入っていたら 上書きしない
      if (useProjectListStore.getState().projects.length > 0) return
      useProjectListStore.setState({ projects: rows as unknown as Project[] })
    })
    return () => {
      cancelled = true
    }
  }, [projectsLen, projectsLoading])

  useEffect(() => {
    if (farmsLoading || farmsLen > 0) return
    let cancelled = false
    void listCachedFarms().then((rows) => {
      if (cancelled || rows.length === 0) return
      if (useFarmStore.getState().farms.length > 0) return
      useFarmStore.setState({ farms: rows as unknown as Farm[] })
    })
    return () => {
      cancelled = true
    }
  }, [farmsLen, farmsLoading])
}
