-- 工事（projects / farms とその配下データ）のアクセス制御を「メンバー方式」に統一する。
--
-- 方針:
--   SELECT: project の owner（projects.user_id = auth.uid()）OR project_members に登録ありの誰でも見える
--   INSERT / UPDATE / DELETE: owner OR project_members.role IN ('owner','editor')
--
-- すでに member-aware の design_alignments / staking_records はここでは触らない。
--
-- 副作用: 既存のポリシーを DROP IF EXISTS で取り除いてから再作成する。
-- 適用前にバックアップ推奨。
--
-- 適用方法:
--   1) Supabase Dashboard → SQL Editor → このファイルの内容を貼り付けて実行
--   または
--   2) supabase CLI:  supabase db push

-- ========================================================================
-- 0. ヘルパ関数: 再帰的な RLS 評価を避けるため SECURITY DEFINER で定義
--    （関数オーナー権限で動くため、関数内で参照する projects / project_members
--      の RLS をスルーできる）
-- ========================================================================

CREATE OR REPLACE FUNCTION public.is_project_viewer(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_project_editor(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
      AND pm.role IN ('owner', 'editor')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_farm_viewer(p_farm_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farms f
    WHERE f.id = p_farm_id
      AND (f.user_id = auth.uid() OR public.is_project_viewer(f.project_id))
  );
$$;

CREATE OR REPLACE FUNCTION public.is_farm_editor(p_farm_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farms f
    WHERE f.id = p_farm_id
      AND (f.user_id = auth.uid() OR public.is_project_editor(f.project_id))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_project_viewer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_editor(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_farm_viewer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_farm_editor(uuid) TO authenticated;

-- ========================================================================
-- 1. projects: owner または project_members 登録者
-- ========================================================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select" ON public.projects;
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
DROP POLICY IF EXISTS "projects_update" ON public.projects;
DROP POLICY IF EXISTS "projects_delete" ON public.projects;
DROP POLICY IF EXISTS "Users can view own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can insert own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;

CREATE POLICY "projects_select" ON public.projects FOR SELECT
  USING (user_id = auth.uid() OR public.is_project_viewer(id));

CREATE POLICY "projects_insert" ON public.projects FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "projects_update" ON public.projects FOR UPDATE
  USING (user_id = auth.uid() OR public.is_project_editor(id));

CREATE POLICY "projects_delete" ON public.projects FOR DELETE
  USING (user_id = auth.uid());

-- ========================================================================
-- 2. project_members: 所属プロジェクトのメンバーは一覧を見られる。
--    追加・更新・削除は owner のみ
-- ========================================================================
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;

CREATE POLICY "project_members_select" ON public.project_members FOR SELECT
  USING (user_id = auth.uid() OR public.is_project_viewer(project_id));

CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id AND p.user_id = auth.uid()
    )
  );

-- ========================================================================
-- 3. farms: project の viewer/editor に従う
-- ========================================================================
ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farms_select" ON public.farms;
DROP POLICY IF EXISTS "farms_insert" ON public.farms;
DROP POLICY IF EXISTS "farms_update" ON public.farms;
DROP POLICY IF EXISTS "farms_delete" ON public.farms;
DROP POLICY IF EXISTS "Users can view own farms" ON public.farms;
DROP POLICY IF EXISTS "Users can insert own farms" ON public.farms;
DROP POLICY IF EXISTS "Users can update own farms" ON public.farms;
DROP POLICY IF EXISTS "Users can delete own farms" ON public.farms;

CREATE POLICY "farms_select" ON public.farms FOR SELECT
  USING (user_id = auth.uid() OR public.is_project_viewer(project_id));

CREATE POLICY "farms_insert" ON public.farms FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_project_editor(project_id)
  );

CREATE POLICY "farms_update" ON public.farms FOR UPDATE
  USING (user_id = auth.uid() OR public.is_project_editor(project_id));

CREATE POLICY "farms_delete" ON public.farms FOR DELETE
  USING (user_id = auth.uid() OR public.is_project_editor(project_id));

-- ========================================================================
-- 4. farm_id を持つ「farm 直下」テーブル群を一括設定するヘルパ DO ブロック
--    対象テーブル（存在する場合のみ適用）:
--      design_coordinates, design_pipes, design_survey_data,
--      design_survey_calibration, design_work_areas, design_coordinate_routes,
--      pipe_wiring_groups, construction_plan_rows
-- ========================================================================
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'design_coordinates',
    'design_pipes',
    'design_survey_data',
    'design_survey_calibration',
    'design_work_areas',
    'design_coordinate_routes',
    'pipe_wiring_groups',
    'construction_plan_rows'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    -- 当該テーブルが無ければスキップ
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      CONTINUE;
    END IF;
    -- farm_id カラムが無ければスキップ
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'farm_id'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- 既存ポリシーを掃除
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Users can access %s via project" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Users can access %s via farm" ON public.%I', t, t);

    EXECUTE format($f$
      CREATE POLICY "%s_select" ON public.%I FOR SELECT
      USING (public.is_farm_viewer(farm_id))
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%s_insert" ON public.%I FOR INSERT
      WITH CHECK (public.is_farm_editor(farm_id))
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%s_update" ON public.%I FOR UPDATE
      USING (public.is_farm_editor(farm_id))
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%s_delete" ON public.%I FOR DELETE
      USING (public.is_farm_editor(farm_id))
    $f$, t, t);
  END LOOP;
END $$;

-- ========================================================================
-- 5. 孫テーブル: pipe_wiring_rows（group_id 経由）
-- ========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pipe_wiring_rows'
  ) THEN
    ALTER TABLE public.pipe_wiring_rows ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "pipe_wiring_rows_select" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_insert" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_update" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_delete" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "Users can access pipe_wiring_rows via group" ON public.pipe_wiring_rows;

    CREATE POLICY "pipe_wiring_rows_select" ON public.pipe_wiring_rows FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.is_farm_viewer(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_insert" ON public.pipe_wiring_rows FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.is_farm_editor(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_update" ON public.pipe_wiring_rows FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.is_farm_editor(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_delete" ON public.pipe_wiring_rows FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.is_farm_editor(g.farm_id)
        )
      );
  END IF;
END $$;

-- ========================================================================
-- 6. 孫テーブル: construction_plan_points（row_id 経由）
-- ========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'construction_plan_points'
  ) THEN
    ALTER TABLE public.construction_plan_points ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "construction_plan_points_select" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_insert" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_update" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_delete" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "Users can access construction_plan_points via row" ON public.construction_plan_points;

    CREATE POLICY "construction_plan_points_select" ON public.construction_plan_points FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.is_farm_viewer(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_insert" ON public.construction_plan_points FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.is_farm_editor(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_update" ON public.construction_plan_points FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.is_farm_editor(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_delete" ON public.construction_plan_points FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.is_farm_editor(r.farm_id)
        )
      );
  END IF;
END $$;

-- ========================================================================
-- 7. 孫テーブル: work_area_coordinates（work_area_id 経由）
-- ========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'work_area_coordinates'
  ) THEN
    ALTER TABLE public.work_area_coordinates ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "work_area_coordinates_select" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_insert" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_update" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_delete" ON public.work_area_coordinates;

    CREATE POLICY "work_area_coordinates_select" ON public.work_area_coordinates FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.is_farm_viewer(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_insert" ON public.work_area_coordinates FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.is_farm_editor(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_update" ON public.work_area_coordinates FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.is_farm_editor(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_delete" ON public.work_area_coordinates FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.is_farm_editor(w.farm_id)
        )
      );
  END IF;
END $$;

-- ========================================================================
-- 8. 動作確認用クエリ（手動で実行して効果を確認できる）
--    SELECT polname, polcmd, polqual FROM pg_policy WHERE polrelid = 'public.projects'::regclass;
--    SELECT polname FROM pg_policy WHERE polrelid = 'public.design_coordinates'::regclass;
-- ========================================================================
