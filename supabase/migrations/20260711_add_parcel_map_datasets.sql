-- G 空間情報センターの法務省登記所備付地図 (JPGIS/JSIMA XML) を、サイトオーナーが
-- マスターデータとしてアップロードし、境界測量モードの地図に背景レイヤとして重ねる仕組み。
--
-- スコープ:
--   * 全システム共有 (サイトオーナーのみ管理 / 全認証ユーザーが閲覧・地番取込)
--   * まずは GeoJSON オーバーレイで実装。スキーマの tile_format 列で将来 PMTiles に
--     切り替える余地を残す。
--
-- 追加要素:
--   1. テーブル public.parcel_map_datasets (メタデータ)
--   2. Storage バケット 'parcel-maps' (元 XML + 変換済 GeoJSON)
--   3. RLS ポリシー (SELECT = authenticated / mutations = is_site_owner)
--
-- Supabase Studio SQL Editor で実行してください。

-- ============================================================
-- 1. メタデータテーブル
-- ============================================================

CREATE TABLE IF NOT EXISTS public.parcel_map_datasets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  coordinate_zone       INTEGER NOT NULL CHECK (coordinate_zone BETWEEN 1 AND 19),
  source_kind           TEXT NOT NULL DEFAULT 'jpgis_xml'
                          CHECK (source_kind IN ('jpgis_xml')),
  storage_xml_path      TEXT NOT NULL,
  storage_geojson_path  TEXT,
  tile_format           TEXT NOT NULL DEFAULT 'geojson'
                          CHECK (tile_format IN ('geojson', 'pmtiles')),
  bbox                  JSONB,        -- {minLng, minLat, maxLng, maxLat}
  parcel_count          INTEGER,
  active                BOOLEAN NOT NULL DEFAULT false,
  uploaded_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parcel_map_datasets_active
  ON public.parcel_map_datasets (active) WHERE active;

-- updated_at 自動更新
DROP TRIGGER IF EXISTS trg_parcel_map_datasets_touch ON public.parcel_map_datasets;
CREATE TRIGGER trg_parcel_map_datasets_touch
  BEFORE UPDATE ON public.parcel_map_datasets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 2. RLS
-- ============================================================

ALTER TABLE public.parcel_map_datasets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parcel_map_datasets_select" ON public.parcel_map_datasets;
DROP POLICY IF EXISTS "parcel_map_datasets_insert" ON public.parcel_map_datasets;
DROP POLICY IF EXISTS "parcel_map_datasets_update" ON public.parcel_map_datasets;
DROP POLICY IF EXISTS "parcel_map_datasets_delete" ON public.parcel_map_datasets;

CREATE POLICY "parcel_map_datasets_select" ON public.parcel_map_datasets
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "parcel_map_datasets_insert" ON public.parcel_map_datasets
  FOR INSERT TO authenticated
  WITH CHECK (public.is_site_owner());

CREATE POLICY "parcel_map_datasets_update" ON public.parcel_map_datasets
  FOR UPDATE TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

CREATE POLICY "parcel_map_datasets_delete" ON public.parcel_map_datasets
  FOR DELETE TO authenticated
  USING (public.is_site_owner());

-- ============================================================
-- 3. Storage バケット (プライベート、SELECT は認証済み全員)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('parcel-maps', 'parcel-maps', false)
ON CONFLICT (id) DO NOTHING;

-- パス規約: '<dataset_id>/source.xml' と '<dataset_id>/parcels.geojson'

DROP POLICY IF EXISTS "parcel_maps_storage_select" ON storage.objects;
DROP POLICY IF EXISTS "parcel_maps_storage_insert" ON storage.objects;
DROP POLICY IF EXISTS "parcel_maps_storage_update" ON storage.objects;
DROP POLICY IF EXISTS "parcel_maps_storage_delete" ON storage.objects;

CREATE POLICY "parcel_maps_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'parcel-maps');

CREATE POLICY "parcel_maps_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'parcel-maps' AND public.is_site_owner());

CREATE POLICY "parcel_maps_storage_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'parcel-maps' AND public.is_site_owner());

CREATE POLICY "parcel_maps_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'parcel-maps' AND public.is_site_owner());
