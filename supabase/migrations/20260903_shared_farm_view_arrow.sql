-- 共有ビューの ペイントに 矢印 (arrow) を含める。
-- 20260901 の 差し替え。他の項目は そのまま。

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
    -- ペイント (ストローク / テキスト / 円 / 円弧 / 面 / 点)
    'map_drawings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id,
        'kind', d.kind,
        'color', d.color,
        'width_px', d.width_px,
        'line_style', d.line_style,
        'points', d.points,
        'text', d.text,
        'layer', d.layer,
        'font_size', d.font_size,
        'rotation_deg', d.rotation_deg,
        'arrow', d.arrow
      ) ORDER BY d.created_at)
      FROM public.map_drawings d
      WHERE d.farm_id = p_farm_id
        AND EXISTS (SELECT 1 FROM visible)
    ), '[]'::jsonb)
  );
$$;
