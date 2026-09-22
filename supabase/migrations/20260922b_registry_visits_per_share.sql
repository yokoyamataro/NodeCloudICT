-- 立会 情報 は 「所有者 単位」 では なく 「地番 × 所有者 単位」 (共有持分) で
-- 持つ。 同 所有者 が 複数筆 を 保有 している 場合、地番 ごとに 別々 の
-- 立会 日時 と なり うる ため。
--
-- 移動 内容:
--   ・project_owners から 4 列 (first_visit_at / _status / second_visit_at / _status) を 削除
--   ・property_owner_shares に 同 4 列 を 追加 + notes (地番 メモ) も 追加

BEGIN;

ALTER TABLE public.property_owner_shares
  ADD COLUMN IF NOT EXISTS first_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_visit_status TEXT,
  ADD COLUMN IF NOT EXISTS second_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_visit_status TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 直前 migration で 追加 した ばかり で 実運用 データ は 無い 前提 で 削除
ALTER TABLE public.project_owners
  DROP COLUMN IF EXISTS first_visit_at,
  DROP COLUMN IF EXISTS first_visit_status,
  DROP COLUMN IF EXISTS second_visit_at,
  DROP COLUMN IF EXISTS second_visit_status;

COMMIT;
