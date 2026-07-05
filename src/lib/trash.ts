// ゴミ箱の共通定数。SQL 側 (purge_expired_trash) と揃える。
// 将来的にはユーザー設定 / プロジェクト設定に持たせる予定。

export const TRASH_RETENTION_DAYS = 7

/** deleted_at (ISO 文字列) と今の時刻から、完全削除までの残り日数 (小数第 1 位まで) を返す。
 *  マイナスなら既に保持期間超過 (次の purge で消える対象)。 */
export function daysUntilPurge(deletedAt: string | null): number | null {
  if (!deletedAt) return null
  const d = new Date(deletedAt)
  if (Number.isNaN(d.getTime())) return null
  const cutoff = d.getTime() + TRASH_RETENTION_DAYS * 24 * 3600 * 1000
  const remainMs = cutoff - Date.now()
  return Math.round((remainMs / (24 * 3600 * 1000)) * 10) / 10
}
