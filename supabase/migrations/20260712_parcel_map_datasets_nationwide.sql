-- 全国の法務省地図データを scripts/sync-parcel-maps.mjs で自動投入するため、
-- parcel_map_datasets のスキーマを拡張する。
--
-- 追加列:
--   registry_code       登記所エリアコード (ZIP ファイル名先頭 5 桁 例: '16343')
--   registry_sub        サブコード (ZIP ファイル名 4 桁 例: '2301')
--   prefecture_code     都道府県コード (registry_code の先頭 2 桁)
--   source_year         G 空間側のデータ年度 (例: 2025)
--   source_url          CKAN の download URL (更新検知用)
--   ckan_package_id     CKAN の package UUID
--   ckan_resource_id    CKAN の resource UUID
--
-- ユニーク制約: 同じ (registry_code, registry_sub) は 1 件だけ。
--             新年度が来たら upsert で置き換え。
-- 既存 (registry_code IS NULL) の手動アップロード分は対象外にする。

ALTER TABLE public.parcel_map_datasets
  ADD COLUMN IF NOT EXISTS registry_code text,
  ADD COLUMN IF NOT EXISTS registry_sub text,
  ADD COLUMN IF NOT EXISTS prefecture_code text,
  ADD COLUMN IF NOT EXISTS source_year integer,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS ckan_package_id text,
  ADD COLUMN IF NOT EXISTS ckan_resource_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_parcel_map_datasets_registry
  ON public.parcel_map_datasets (registry_code, registry_sub)
  WHERE registry_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_parcel_map_datasets_prefecture
  ON public.parcel_map_datasets (prefecture_code);

-- Phase 2b (工区 bbox で交差する dataset を絞り込む) 用のスカラー bbox 列。
-- 既存 bbox jsonb からも変換できるが、CLI 投入時にそのまま埋める。
ALTER TABLE public.parcel_map_datasets
  ADD COLUMN IF NOT EXISTS bbox_min_lng double precision,
  ADD COLUMN IF NOT EXISTS bbox_min_lat double precision,
  ADD COLUMN IF NOT EXISTS bbox_max_lng double precision,
  ADD COLUMN IF NOT EXISTS bbox_max_lat double precision;

CREATE INDEX IF NOT EXISTS ix_parcel_map_datasets_bbox_lng
  ON public.parcel_map_datasets (bbox_min_lng, bbox_max_lng);
CREATE INDEX IF NOT EXISTS ix_parcel_map_datasets_bbox_lat
  ON public.parcel_map_datasets (bbox_min_lat, bbox_max_lat);

-- 既存レコードの bbox jsonb からスカラー列にコピー (nullable のまま埋めるだけ)
UPDATE public.parcel_map_datasets
  SET bbox_min_lng = (bbox->>'minLng')::double precision,
      bbox_min_lat = (bbox->>'minLat')::double precision,
      bbox_max_lng = (bbox->>'maxLng')::double precision,
      bbox_max_lat = (bbox->>'maxLat')::double precision
  WHERE bbox IS NOT NULL AND bbox_min_lng IS NULL;
