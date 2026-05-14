-- プロジェクトごとのカスタム座標点種
-- 既定（control/boundary/current）に加えて、ユーザーが任意の点種を追加できる。
-- 追加した点種は同一プロジェクト配下の全圃場で利用可能。
--
-- design_coordinates.coordinate_type には引き続き「code」を文字列として保存する。
-- このテーブルは code に対する表示名（label）を提供する辞書として機能する。

CREATE TABLE IF NOT EXISTS public.coordinate_point_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coordinate_point_types_project_id
  ON public.coordinate_point_types(project_id);

-- updated_at 自動更新
DROP TRIGGER IF EXISTS update_coordinate_point_types_updated_at ON public.coordinate_point_types;
CREATE TRIGGER update_coordinate_point_types_updated_at
  BEFORE UPDATE ON public.coordinate_point_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS: プロジェクトメンバー方式
ALTER TABLE public.coordinate_point_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coordinate_point_types_select" ON public.coordinate_point_types;
DROP POLICY IF EXISTS "coordinate_point_types_insert" ON public.coordinate_point_types;
DROP POLICY IF EXISTS "coordinate_point_types_update" ON public.coordinate_point_types;
DROP POLICY IF EXISTS "coordinate_point_types_delete" ON public.coordinate_point_types;

CREATE POLICY "coordinate_point_types_select" ON public.coordinate_point_types
  FOR SELECT USING (public.is_project_viewer(project_id));

CREATE POLICY "coordinate_point_types_insert" ON public.coordinate_point_types
  FOR INSERT WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY "coordinate_point_types_update" ON public.coordinate_point_types
  FOR UPDATE USING (public.is_project_editor(project_id));

CREATE POLICY "coordinate_point_types_delete" ON public.coordinate_point_types
  FOR DELETE USING (public.is_project_editor(project_id));

-- 共有ビュー（get_shared_farm_view）にカスタム点種を追加で返す
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
    'point_types', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'code', t.code,
        'label', t.label
      ) ORDER BY t.sort_order, t.created_at)
      FROM public.coordinate_point_types t
      JOIN public.farms f ON f.project_id = t.project_id
      WHERE f.id = p_farm_id
    ), '[]'::jsonb),
    'route', (
      SELECT jsonb_build_object('points', r.points)
      FROM public.export_point_routes r
      WHERE r.farm_id = p_farm_id
      LIMIT 1
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shared_farm_view(uuid) TO authenticated;
