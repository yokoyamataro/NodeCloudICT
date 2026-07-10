-- 組織 (organizations) に郵便番号列を追加する。
--
-- ハイフン有無どちらでも許容する運用のため CHECK 制約は付けない。
-- 表示・検索用途で使えれば十分。

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS postal_code text;
