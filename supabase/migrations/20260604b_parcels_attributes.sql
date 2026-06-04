-- parcels に地籍属性列を追加する。
--
-- 列:
--   registered_land_category  ... 登記地目（不動産登記規則 第99条 の 23 地目）
--   registered_area_sqm       ... 登記地積（m²）
--   updated_land_category     ... 変更地目（現況地目。23 地目から選択）
--   updated_area_sqm          ... 変更地積（m²）
--   owner_address             ... 所有者住所
--   owner_name                ... 所有者氏名
--   attended_at               ... 立会日時
--
-- 地目は CHECK 制約で値を固定する（NULL は許可）。値の一覧はフロント側
-- (src/lib/landCategory.ts) と必ず一致させること。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

ALTER TABLE public.parcels
  ADD COLUMN IF NOT EXISTS registered_land_category text,
  ADD COLUMN IF NOT EXISTS registered_area_sqm numeric(15, 4),
  ADD COLUMN IF NOT EXISTS updated_land_category text,
  ADD COLUMN IF NOT EXISTS updated_area_sqm numeric(15, 4),
  ADD COLUMN IF NOT EXISTS owner_address text,
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS attended_at timestamptz;

-- 地目 CHECK 制約（不動産登記規則 第99条 の 23 地目）
-- 既存制約があれば一度落としてから付け直す
ALTER TABLE public.parcels
  DROP CONSTRAINT IF EXISTS parcels_registered_land_category_check;
ALTER TABLE public.parcels
  DROP CONSTRAINT IF EXISTS parcels_updated_land_category_check;

ALTER TABLE public.parcels
  ADD CONSTRAINT parcels_registered_land_category_check
  CHECK (
    registered_land_category IS NULL OR registered_land_category IN (
      '田','畑','宅地','学校用地','鉄道用地','塩田','鉱泉地','池沼','山林',
      '牧場','原野','墓地','境内地','運河用地','水道用地','用悪水路',
      'ため池','堤','井溝','保安林','公衆用道路','公園','雑種地'
    )
  );

ALTER TABLE public.parcels
  ADD CONSTRAINT parcels_updated_land_category_check
  CHECK (
    updated_land_category IS NULL OR updated_land_category IN (
      '田','畑','宅地','学校用地','鉄道用地','塩田','鉱泉地','池沼','山林',
      '牧場','原野','墓地','境内地','運河用地','水道用地','用悪水路',
      'ため池','堤','井溝','保安林','公衆用道路','公園','雑種地'
    )
  );
