-- 物件 (registry_properties) に 「登録区分」 を 追加。
-- CSV 由来 は registered、手動追加 は provisional / confirmed。
-- 手動追加 の 分筆新地 は split_from_property_id で 既存 の 分筆元 に 紐付ける。
-- 合筆 は 既存 の merged_into_property_id / merged_area_sqm カラム で 表現。

BEGIN;

ALTER TABLE public.registry_properties
  ADD COLUMN IF NOT EXISTS registration_kind TEXT NOT NULL DEFAULT 'registered';

-- CHECK 制約 は 既存 データ に 対して も 適用 する 必要 が あり、
-- テーブル 内 の 値 は 全て 'registered' で 埋まって いる (DEFAULT 実行済) ため 安全。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'registry_properties_registration_kind_chk'
  ) THEN
    ALTER TABLE public.registry_properties
      ADD CONSTRAINT registry_properties_registration_kind_chk
      CHECK (registration_kind IN ('registered', 'provisional', 'confirmed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_registry_properties_kind
  ON public.registry_properties(project_id, registration_kind);

COMMIT;
