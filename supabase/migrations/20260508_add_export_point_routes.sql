-- 出力点選択（順路）の保存テーブル
-- 圃場ごとに 1 件。JSON 配列で出力点（id, name, x, y, z, source, type）を順番付きで保持する。
-- 用途: スマホ起工測量画面で暗渠ターゲットをこの順序で並べる、CAD/SIMA 出力で同じ順序を再利用する。

CREATE TABLE IF NOT EXISTS public.export_point_routes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  points JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  UNIQUE (farm_id)
);

CREATE INDEX IF NOT EXISTS idx_export_point_routes_farm_id ON public.export_point_routes(farm_id);

-- updated_at 自動更新トリガー（既存関数を利用）
DROP TRIGGER IF EXISTS update_export_point_routes_updated_at ON public.export_point_routes;
CREATE TRIGGER update_export_point_routes_updated_at
  BEFORE UPDATE ON public.export_point_routes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- メンバー方式 RLS（farm_work_status と同じ運用方針）
ALTER TABLE public.export_point_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "export_point_routes_select" ON public.export_point_routes;
DROP POLICY IF EXISTS "export_point_routes_insert" ON public.export_point_routes;
DROP POLICY IF EXISTS "export_point_routes_update" ON public.export_point_routes;
DROP POLICY IF EXISTS "export_point_routes_delete" ON public.export_point_routes;

CREATE POLICY "export_point_routes_select" ON public.export_point_routes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = export_point_routes.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "export_point_routes_insert" ON public.export_point_routes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = export_point_routes.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY "export_point_routes_update" ON public.export_point_routes FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = export_point_routes.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY "export_point_routes_delete" ON public.export_point_routes FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = export_point_routes.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );
