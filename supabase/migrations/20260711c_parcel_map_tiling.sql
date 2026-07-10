-- 地番マップ (parcel_map_datasets) をアップロード時にタイル分割して、
-- 工区側は必要な範囲だけダウンロードできるようにする。
--
-- 変更点:
--   1. parcel_map_datasets に tile_zoom 列を追加 (デフォルト 14)
--      アップロード時にこのズームレベルでタイル分割する
--      Storage 上の tile パス: '<dataset_id>/tiles/<z>/<x>/<y>.geojson'
--      タイル索引:              '<dataset_id>/tiles/index.json'
--   2. farms に parcel_map_bbox 列を追加 (nullable)
--      工区の 地番マップ表示範囲。null なら「工区周辺を自動計算」する

ALTER TABLE public.parcel_map_datasets
  ADD COLUMN IF NOT EXISTS tile_zoom integer NOT NULL DEFAULT 14
    CHECK (tile_zoom BETWEEN 10 AND 18);

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS parcel_map_bbox jsonb;
