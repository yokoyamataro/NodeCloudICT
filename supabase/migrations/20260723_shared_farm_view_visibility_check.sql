-- get_shared_farm_view: visibility='public' でない farm への anon アクセスを拒否する。
--
-- 既存の実装は「farm UUID を知っていれば誰でも閲覧可能」だったため、UUID が漏洩すると
-- 座標・パイプ・route が意図せず外部に晒されるリスクがあった。UUID は予測不能とはいえ、
-- 明示的な visibility チェックがなかったのは security 設計上の穴。
--
-- 対応:
--   1. 親プロジェクトの visibility が 'public' である場合のみ返す
--   2. それ以外は 'farm' キーを NULL にした空の JSON を返し、フロント側に「共有無効」と伝える
--
-- 既存の 'coordinates' / 'pipes' / 'point_types' / 'route' などのカラムは変更しない
-- (public の場合は従来どおり返る)。

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
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_shared_farm_view(uuid) IS
  $$共有ページ用: 親プロジェクトの visibility='public' のときのみ farm データを返す。非 public の場合は farm=NULL, coordinates/pipes/... は空配列。$$;
