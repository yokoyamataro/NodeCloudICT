-- 現場 (projects) から「工期予定」(start_date / end_date) を撤廃する。
-- 実務では started_at / completed_at (実績) だけで運用できているため、予定期間の
-- 二重管理を止める。
--
-- 依存: フロントエンドから start_date / end_date への参照を全て削除済み。

ALTER TABLE public.projects
  DROP COLUMN IF EXISTS start_date,
  DROP COLUMN IF EXISTS end_date;
