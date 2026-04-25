-- 20260425_member_based_rls_fix.sql で残った無限再帰（42P17）を解消する第二弾。
--
-- 原因:
--   Postgres のプランナーは、ポリシー相互参照（projects ↔ project_members）を
--   静的に検出して 42P17 を出す。インラインの EXISTS では避けられない。
--   SQL 言語のヘルパ関数も「inline」最適化されると同じ検出に引っかかる。
--
-- 対策:
--   LANGUAGE plpgsql の SECURITY DEFINER 関数を使う。
--   plpgsql 関数はプランナーから見て「不透明」なため inline されず、
--   実行時に SECURITY DEFINER で関数オーナー（postgres / BYPASSRLS 持ち）
--   として走るので RLS 評価を再帰しない。
--
-- 副作用:
--   旧マイグレーションが残したポリシーを全部置き換える。
--
-- 適用方法: Supabase Dashboard → SQL Editor に貼って実行。

-- ========================================================================
-- 0. 既存ヘルパ関数（あれば）を撤去（CASCADE で依存ポリシーごと外す）
-- ========================================================================
DROP FUNCTION IF EXISTS public.is_project_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_project_editor(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_editor(uuid) CASCADE;

-- ========================================================================
-- 1. plpgsql ヘルパ関数（プランナーから不透明 → 循環検出されない）
-- ========================================================================
CREATE OR REPLACE FUNCTION public.fn_is_project_viewer(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
  ok boolean;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.projects WHERE id = p_project_id AND user_id = uid
  ) OR EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND user_id = uid
  ) INTO ok;
  RETURN ok;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_is_project_editor(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
  ok boolean;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.projects WHERE id = p_project_id AND user_id = uid
  ) OR EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id
      AND user_id = uid
      AND role IN ('owner', 'editor')
  ) INTO ok;
  RETURN ok;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_is_farm_viewer(p_farm_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
  pid uuid;
  fown uuid;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  SELECT project_id, user_id INTO pid, fown FROM public.farms WHERE id = p_farm_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF fown = uid THEN RETURN true; END IF;
  RETURN public.fn_is_project_viewer(pid);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_is_farm_editor(p_farm_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
  pid uuid;
  fown uuid;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  SELECT project_id, user_id INTO pid, fown FROM public.farms WHERE id = p_farm_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF fown = uid THEN RETURN true; END IF;
  RETURN public.fn_is_project_editor(pid);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_is_project_viewer(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_project_editor(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_farm_viewer(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_farm_editor(uuid) TO authenticated, anon;

-- ========================================================================
-- 2. projects
-- ========================================================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select" ON public.projects;
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
DROP POLICY IF EXISTS "projects_update" ON public.projects;
DROP POLICY IF EXISTS "projects_delete" ON public.projects;

CREATE POLICY "projects_select" ON public.projects FOR SELECT
  USING (user_id = auth.uid() OR public.fn_is_project_viewer(id));

CREATE POLICY "projects_insert" ON public.projects FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "projects_update" ON public.projects FOR UPDATE
  USING (user_id = auth.uid() OR public.fn_is_project_editor(id));

CREATE POLICY "projects_delete" ON public.projects FOR DELETE
  USING (user_id = auth.uid());

-- ========================================================================
-- 3. project_members
-- ========================================================================
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;

CREATE POLICY "project_members_select" ON public.project_members FOR SELECT
  USING (user_id = auth.uid() OR public.fn_is_project_viewer(project_id));

CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT
  WITH CHECK (public.fn_is_project_editor(project_id));

CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE
  USING (public.fn_is_project_editor(project_id));

CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE
  USING (public.fn_is_project_editor(project_id));

-- ========================================================================
-- 4. farms
-- ========================================================================
ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farms_select" ON public.farms;
DROP POLICY IF EXISTS "farms_insert" ON public.farms;
DROP POLICY IF EXISTS "farms_update" ON public.farms;
DROP POLICY IF EXISTS "farms_delete" ON public.farms;

CREATE POLICY "farms_select" ON public.farms FOR SELECT
  USING (user_id = auth.uid() OR public.fn_is_project_viewer(project_id));

CREATE POLICY "farms_insert" ON public.farms FOR INSERT
  WITH CHECK (user_id = auth.uid() AND public.fn_is_project_editor(project_id));

CREATE POLICY "farms_update" ON public.farms FOR UPDATE
  USING (user_id = auth.uid() OR public.fn_is_project_editor(project_id));

CREATE POLICY "farms_delete" ON public.farms FOR DELETE
  USING (user_id = auth.uid() OR public.fn_is_project_editor(project_id));

-- ========================================================================
-- 5. farm_id を持つテーブル群
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
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'farm_id'
    ) THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (public.fn_is_farm_viewer(farm_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.fn_is_farm_editor(farm_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.fn_is_farm_editor(farm_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.fn_is_farm_editor(farm_id))',
      t, t
    );
  END LOOP;
END $$;

-- ========================================================================
-- 6. 孫テーブル: pipe_wiring_rows（group_id → pipe_wiring_groups.farm_id）
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

    CREATE POLICY "pipe_wiring_rows_select" ON public.pipe_wiring_rows FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.fn_is_farm_viewer(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_insert" ON public.pipe_wiring_rows FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.fn_is_farm_editor(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_update" ON public.pipe_wiring_rows FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.fn_is_farm_editor(g.farm_id)
        )
      );

    CREATE POLICY "pipe_wiring_rows_delete" ON public.pipe_wiring_rows FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          WHERE g.id = pipe_wiring_rows.group_id
            AND public.fn_is_farm_editor(g.farm_id)
        )
      );
  END IF;
END $$;

-- ========================================================================
-- 7. 孫テーブル: construction_plan_points（row_id → construction_plan_rows.farm_id）
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

    CREATE POLICY "construction_plan_points_select" ON public.construction_plan_points FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.fn_is_farm_viewer(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_insert" ON public.construction_plan_points FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.fn_is_farm_editor(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_update" ON public.construction_plan_points FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.fn_is_farm_editor(r.farm_id)
        )
      );

    CREATE POLICY "construction_plan_points_delete" ON public.construction_plan_points FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          WHERE r.id = construction_plan_points.row_id
            AND public.fn_is_farm_editor(r.farm_id)
        )
      );
  END IF;
END $$;

-- ========================================================================
-- 8. 孫テーブル: work_area_coordinates（work_area_id → design_work_areas.farm_id）
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
            AND public.fn_is_farm_viewer(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_insert" ON public.work_area_coordinates FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.fn_is_farm_editor(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_update" ON public.work_area_coordinates FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.fn_is_farm_editor(w.farm_id)
        )
      );

    CREATE POLICY "work_area_coordinates_delete" ON public.work_area_coordinates FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          WHERE w.id = work_area_coordinates.work_area_id
            AND public.fn_is_farm_editor(w.farm_id)
        )
      );
  END IF;
END $$;
