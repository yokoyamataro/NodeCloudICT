// 工事種別に応じた左メニュー（サイドバー）の表示制御。
// AppLayout 側の navigation 定義の href（先頭一致）でフィルタするので、
// nav の href を変えるときはここの集合も合わせて更新する必要がある。

import type { ProjectCategory } from '@/types/database'

// 種別ごとに「隠す」ルートの prefix。
const HIDDEN_BY_CATEGORY: Record<ProjectCategory, readonly string[]> = {
  // 地籍測量では土木系の工種メニューを出さない
  cadastral: [
    '/underdrain',
    '/soil-import',
    '/simple-grading',
    '/grading',
    '/subsoil',
    '/stone-removal',
    '/open-channel',
  ],
  // 土木工事では境界測量を出さない
  civil: ['/boundary-survey'],
}

// nav 項目の href が、指定種別で表示対象かを判定する。
// category が null（未分類）の場合はサイドバーは出さない運用なので、ここに来る想定はないが、
// 念のため何も隠さないで返す。
export function isNavVisibleForCategory(
  href: string,
  category: ProjectCategory | null,
): boolean {
  if (category == null) return true
  const hidden = HIDDEN_BY_CATEGORY[category] ?? []
  return !hidden.some((prefix) => href === prefix || href.startsWith(prefix + '/'))
}
