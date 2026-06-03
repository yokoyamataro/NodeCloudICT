-- 工事に種別（地籍測量 / 土木工事）を持たせるための列追加。
--
-- 値:
--   'cadastral' ... 地籍測量
--   'civil'     ... 土木工事
--   NULL        ... 未分類（既存データはここに落ちる。工区を開くタイミングで分類する運用）
--
-- 左メニューの表示制御や、トップページの一覧分割で使う。
-- 適用方法: Supabase Dashboard → SQL Editor で実行。

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS category text;

-- 既に列があり、別の CHECK が付いている可能性を考慮して一度 DROP してから付け直す
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_category_check;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_category_check
  CHECK (category IS NULL OR category IN ('cadastral', 'civil'));
