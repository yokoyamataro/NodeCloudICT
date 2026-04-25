-- 20260425_member_based_rls_fix2.sql で残った無限再帰を、シンプルな構造で根治する。
--
-- ★ 鍵となるルール:
--   project_members.SELECT は「user_id = auth.uid()」だけにして、
--   他テーブルへのクロス参照を一切しない。これで循環の鎖を断ち切る。
--
--   projects / farms / design_* の SELECT は project_members を直接 EXISTS する
--   （projects は経由しない）。project_members の policy は単純なので
--   ここから新たな循環は発生しない。
--
-- ★ 副次対応:
--   この方針だと「project の owner が他のメンバー一覧を見る」ができなくなる。
--   そのため SECURITY DEFINER 関数 public.get_project_members(uuid) を提供し、
--   フロントエンドはこの RPC を使ってメンバー一覧を取得する（owner 以外は弾く）。
--
-- 適用方法: Supabase Dashboard → SQL Editor に貼って実行。

-- ========================================================================
-- 0. 旧ヘルパ関数を撤去（依存ポリシーごと CASCADE）
-- ========================================================================
DROP FUNCTION IF EXISTS public.fn_is_project_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.fn_is_project_editor(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.fn_is_farm_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.fn_is_farm_editor(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_project_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_project_editor(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_editor(uuid) CASCADE;

-- ========================================================================
-- 1. project_members
--    SELECT は自分の行だけ。owner が他メンバー一覧を見るには RPC を使う。
-- ========================================================================
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;

-- ★ 重要: ここから他テーブルへ EXISTS しない！
CREATE POLICY "project_members_select" ON public.project_members FOR SELECT
  USING (user_id = auth.uid());

-- INSERT/UPDATE/DELETE は project の owner のみ。
-- projects への EXISTS は許可（projects.SELECT が再び project_members を見ても、
-- そこは user_id = auth.uid() で完結するので循環しない）
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
-- 2. projects
--    自分が owner、または project_members に登録されている。
--    project_members への EXISTS は安全（その先で循環しないため）。
-- ========================================================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select" ON public.projects;
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
DROP POLICY IF EXISTS "projects_update" ON public.projects;
DROP POLICY IF EXISTS "projects_delete" ON public.projects;

CREATE POLICY "projects_select" ON public.projects FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "projects_insert" ON public.projects FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "projects_update" ON public.projects FOR UPDATE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'editor')
    )
  );

CREATE POLICY "projects_delete" ON public.projects FOR DELETE
  USING (user_id = auth.uid());

-- ========================================================================
-- 3. farms
-- ========================================================================
ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farms_select" ON public.farms;
DROP POLICY IF EXISTS "farms_insert" ON public.farms;
DROP POLICY IF EXISTS "farms_update" ON public.farms;
DROP POLICY IF EXISTS "farms_delete" ON public.farms;

CREATE POLICY "farms_select" ON public.farms FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "farms_insert" ON public.farms FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'editor')
    )
  );

CREATE POLICY "farms_update" ON public.farms FOR UPDATE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'editor')
    )
  );

CREATE POLICY "farms_delete" ON public.farms FOR DELETE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'editor')
    )
  );

-- ========================================================================
-- 4. farm_id を持つテーブル群
-- ========================================================================
DO $$
DECLARE
  t text;
  view_using text;
  edit_using text;
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
  view_using := $sql$
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = %1$I.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  $sql$;

  edit_using := $sql$
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = %1$I.farm_id
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
  $sql$;

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
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (' || view_using || ')',
      t, t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (' || edit_using || ')',
      t, t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (' || edit_using || ')',
      t, t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (' || edit_using || ')',
      t, t, t
    );
  END LOOP;
END $$;

-- ========================================================================
-- 5. 孫テーブル（pipe_wiring_rows / construction_plan_points / work_area_coordinates）
-- ========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'pipe_wiring_rows') THEN
    ALTER TABLE public.pipe_wiring_rows ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "pipe_wiring_rows_select" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_insert" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_update" ON public.pipe_wiring_rows;
    DROP POLICY IF EXISTS "pipe_wiring_rows_delete" ON public.pipe_wiring_rows;

    CREATE POLICY "pipe_wiring_rows_select" ON public.pipe_wiring_rows FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          JOIN public.farms f ON f.id = g.farm_id
          WHERE g.id = pipe_wiring_rows.group_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.project_members pm
                WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              )
            )
        )
      );

    CREATE POLICY "pipe_wiring_rows_insert" ON public.pipe_wiring_rows FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          JOIN public.farms f ON f.id = g.farm_id
          WHERE g.id = pipe_wiring_rows.group_id
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

    CREATE POLICY "pipe_wiring_rows_update" ON public.pipe_wiring_rows FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          JOIN public.farms f ON f.id = g.farm_id
          WHERE g.id = pipe_wiring_rows.group_id
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

    CREATE POLICY "pipe_wiring_rows_delete" ON public.pipe_wiring_rows FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.pipe_wiring_groups g
          JOIN public.farms f ON f.id = g.farm_id
          WHERE g.id = pipe_wiring_rows.group_id
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
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'construction_plan_points') THEN
    ALTER TABLE public.construction_plan_points ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "construction_plan_points_select" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_insert" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_update" ON public.construction_plan_points;
    DROP POLICY IF EXISTS "construction_plan_points_delete" ON public.construction_plan_points;

    CREATE POLICY "construction_plan_points_select" ON public.construction_plan_points FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          JOIN public.farms f ON f.id = r.farm_id
          WHERE r.id = construction_plan_points.row_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.project_members pm
                WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              )
            )
        )
      );

    CREATE POLICY "construction_plan_points_insert" ON public.construction_plan_points FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          JOIN public.farms f ON f.id = r.farm_id
          WHERE r.id = construction_plan_points.row_id
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

    CREATE POLICY "construction_plan_points_update" ON public.construction_plan_points FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          JOIN public.farms f ON f.id = r.farm_id
          WHERE r.id = construction_plan_points.row_id
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

    CREATE POLICY "construction_plan_points_delete" ON public.construction_plan_points FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.construction_plan_rows r
          JOIN public.farms f ON f.id = r.farm_id
          WHERE r.id = construction_plan_points.row_id
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
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'work_area_coordinates') THEN
    ALTER TABLE public.work_area_coordinates ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "work_area_coordinates_select" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_insert" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_update" ON public.work_area_coordinates;
    DROP POLICY IF EXISTS "work_area_coordinates_delete" ON public.work_area_coordinates;

    CREATE POLICY "work_area_coordinates_select" ON public.work_area_coordinates FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          JOIN public.farms f ON f.id = w.farm_id
          WHERE w.id = work_area_coordinates.work_area_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.project_members pm
                WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              )
            )
        )
      );

    CREATE POLICY "work_area_coordinates_insert" ON public.work_area_coordinates FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          JOIN public.farms f ON f.id = w.farm_id
          WHERE w.id = work_area_coordinates.work_area_id
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

    CREATE POLICY "work_area_coordinates_update" ON public.work_area_coordinates FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          JOIN public.farms f ON f.id = w.farm_id
          WHERE w.id = work_area_coordinates.work_area_id
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

    CREATE POLICY "work_area_coordinates_delete" ON public.work_area_coordinates FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM public.design_work_areas w
          JOIN public.farms f ON f.id = w.farm_id
          WHERE w.id = work_area_coordinates.work_area_id
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
  END IF;
END $$;

-- ========================================================================
-- 6. RPC: project owner が他のメンバー一覧を取得するための関数
--    project_members.SELECT は user_id = auth.uid() のみ許可なので、
--    UI で「メンバー一覧」を表示するにはこの RPC を使う。
-- ========================================================================
CREATE OR REPLACE FUNCTION public.get_project_members(p_project_id uuid)
RETURNS SETOF public.project_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- 呼び出し元が project の owner であるか、またはこの project の member 自身か
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = uid
  ) AND NOT EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = uid
  ) THEN
    RAISE EXCEPTION 'Not authorized to view members of this project';
  END IF;

  RETURN QUERY
    SELECT * FROM public.project_members
    WHERE project_id = p_project_id
    ORDER BY created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_members(uuid) TO authenticated;
