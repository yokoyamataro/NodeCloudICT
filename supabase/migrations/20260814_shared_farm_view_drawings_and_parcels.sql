-- ============================================================
-- 公開共有 (/share/farm/:farmId) の機能拡張:
--   1. 描画メモ (map_drawings) を含めて返す
--   2. 法務省地図 (parcel_map_datasets + parcel-maps バケット) を
--      anon (未認証) からも SELECT できるようにする
--      * 地番取込 (mutations) はそのまま authenticated + is_site_owner のみ
--
-- get_shared_farm_view は visibility='public' の親プロジェクトの場合のみ
-- データを返す既存ロジックを維持する。
-- ============================================================

-- ---- 1. get_shared_farm_view: map_drawings を含める ----
CREATE OR REPLACE FUNCTION public.get_shared_farm_view(p_farm_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT f.id AS farm_id
    FROM public.farms f
    JOIN public.projects p ON p.id = f.project_id
    WHERE f.id = p_farm_id
      AND p.visibility = 'public'
      AND p.deleted_at IS NULL
  )
  SELECT jsonb_build_object(
    'farm', (
      SELECT jsonb_build_object(
        'id', f.id,
        'name', f.name,
        'project_id', f.project_id,
        'coordinate_zone', COALESCE(p.coordinate_zone, 6)
      )
      FROM public.farms f
      LEFT JOIN public.projects p ON p.id = f.project_id
      WHERE f.id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ),
    'coordinates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id,
        'point_number', c.point_number,
        'x', c.x,
        'y', c.y,
        'z', c.z,
        'latitude', c.latitude,
        'longitude', c.longitude,
        'coordinate_type', c.coordinate_type
      ) ORDER BY c.point_number)
      FROM public.design_coordinates c
      WHERE c.farm_id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ), '[]'::jsonb),
    'pipes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'number', p.number,
        'layer_name', p.layer_name,
        'pipe_type', p.pipe_type,
        'diameter', p.diameter,
        'design_length', p.design_length,
        'vertices', p.vertices
      ) ORDER BY p.number)
      FROM public.design_pipes p
      WHERE p.farm_id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ), '[]'::jsonb),
    'point_types', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'code', t.code,
        'label', t.label
      ) ORDER BY t.sort_order, t.created_at)
      FROM public.coordinate_point_types t
      JOIN public.farms f ON f.project_id = t.project_id
      WHERE f.id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ), '[]'::jsonb),
    'route', (
      SELECT jsonb_build_object('points', r.points)
      FROM public.export_point_routes r
      WHERE r.farm_id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
      LIMIT 1
    ),
    -- 描画メモ (ストローク / テキスト / 円 / 円弧 / 面)
    'map_drawings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id,
        'kind', d.kind,
        'color', d.color,
        'width_px', d.width_px,
        'line_style', d.line_style,
        'points', d.points,
        'text', d.text
      ) ORDER BY d.created_at)
      FROM public.map_drawings d
      WHERE d.farm_id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_shared_farm_view(uuid) IS
  $$共有ページ用: visibility='public' の親プロジェクトのときのみ farm データ (座標 / 配管 / 順路 / 描画メモ) を返す。非 public は farm=NULL。$$;

-- ---- 2. parcel_map_datasets: anon にも SELECT を許可 ----
-- 法務省地図データはサイトオーナーが管理する 公開マスターデータ (JPGIS/JSIMA)。
-- 個人情報は含まれないため anon 閲覧を許可する。書込 (mutations) は既存のまま
-- is_site_owner のみ。
DROP POLICY IF EXISTS "parcel_map_datasets_select_anon" ON public.parcel_map_datasets;
CREATE POLICY "parcel_map_datasets_select_anon" ON public.parcel_map_datasets
  FOR SELECT TO anon USING (true);

-- ---- 3. parcel-maps ストレージバケット: anon にも SELECT を許可 ----
DROP POLICY IF EXISTS "parcel_maps_storage_select_anon" ON storage.objects;
CREATE POLICY "parcel_maps_storage_select_anon" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'parcel-maps');
