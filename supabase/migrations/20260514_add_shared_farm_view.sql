-- 圃場の公開ビュー（URL を知れば誰でも見られる簡易共有）
--
-- 用途: 起工測量画面で「共有リンク発行」ボタンを押すと
--   /share/farm/{farmId} の URL が生成され、LINE 等で他社に渡せる。
--
-- 方針:
--   - SECURITY DEFINER 関数で必要最小限のデータだけ JSON で返す
--   - anon ロールに EXECUTE 権限を付与し、ログイン不要で読み取れるようにする
--   - 受益者名や連絡先など個人情報を含む列は返さない
--   - farm UUID を知らない限りアクセスできない（推測不能な乱数として機能）
--
-- 返却内容:
--   {
--     farm: { id, name, project_id, coordinate_zone },
--     coordinates: [ { id, point_number, x, y, z, latitude, longitude, coordinate_type } ],
--     pipes:       [ { id, number, layer_name, pipe_type, diameter, design_length, vertices } ],
--     route:       { points: [...] }  -- export_point_routes の points JSONB をそのまま
--   }

CREATE OR REPLACE FUNCTION public.get_shared_farm_view(p_farm_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    ), '[]'::jsonb),
    'route', (
      SELECT jsonb_build_object('points', r.points)
      FROM public.export_point_routes r
      WHERE r.farm_id = p_farm_id
      LIMIT 1
    )
  );
$$;

-- 公開アクセスを許可（anon = 未ログインユーザー）
GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO authenticated;
