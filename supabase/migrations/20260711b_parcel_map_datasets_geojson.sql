-- parcel_map_datasets が GeoJSON 直接アップロードにも対応できるようにする。
--
-- 変更点:
--   1. source_kind の CHECK 制約に 'geojson' を追加
--   2. storage_xml_path を NULLABLE にする (GeoJSON 直接アップロード時は
--      元 XML が存在しないため)

-- 1. source_kind CHECK: 既存の自動命名 constraint を消して再追加
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'parcel_map_datasets'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%source_kind%'
  LOOP
    EXECUTE 'ALTER TABLE public.parcel_map_datasets DROP CONSTRAINT ' || quote_ident(cname);
  END LOOP;
END $$;

ALTER TABLE public.parcel_map_datasets
  ADD CONSTRAINT parcel_map_datasets_source_kind_check
  CHECK (source_kind IN ('jpgis_xml', 'geojson'));

-- 2. storage_xml_path を NULLABLE に
ALTER TABLE public.parcel_map_datasets
  ALTER COLUMN storage_xml_path DROP NOT NULL;
