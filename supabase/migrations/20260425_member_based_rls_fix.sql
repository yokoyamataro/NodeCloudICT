-- 20260425_member_based_rls.sql の修正版。
-- 元マイグレーションは SECURITY DEFINER ヘルパ関数を介して RLS を組んでいたが、
-- 関数 owner が BYPASSRLS でない環境では project_members の自己参照で
-- 無限再帰（Postgres 42P17）→ HTTP 500 になる事象が発生した。
--
-- このマイグレーションでは:
--   1) ヘルパ関数を撤去
--   2) projects / project_members のポリシーから project_members 自身への
--      参照を排除（projects 側だけが project_members を見る）
--   3) farms 配下の各テーブルは projects.user_id か project_members の
--      EXISTS をインライン展開
--
-- 適用方法は前回と同じ。Supabase SQL Editor に貼って実行。

-- ========================================================================
-- 0. 旧ヘルパ関数を撤去
-- ========================================================================
DROP FUNCTION IF EXISTS public.is_project_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_project_editor(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_viewer(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_farm_editor(uuid) CASCADE;

-- ========================================================================
-- 1. projects: 自分が owner、または project_members に登録されている
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
      WHERE pm.project_id = projects.id
        AND pm.user_id = auth.uid()
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
-- 2. project_members: 自身の行 OR その project の owner なら全行見える
--    （project_members 内から projects は参照するが、projects 側では
--      user_id = auth.uid() ブランチが先に true 評価されるので再帰しない）
-- ========================================================================
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;

CREATE POLICY "project_members_select" ON public.project_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.user_id = auth.uid()
    )
  );

-- ========================================================================
-- 3. farms: own か、project owner か、project_members 登録者
--    （EXISTS インライン展開）
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
      SELECT 1 FROM public.projects p
      WHERE p.id = farms.project_id AND p.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "farms_insert" ON public.farms FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = farms.project_id AND p.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.project_members pm
        WHERE pm.project_id = farms.project_id
          AND pm.user_id = auth.uid()
          AND pm.role IN ('owner', 'editor')
      )
    )
  );

CREATE POLICY "farms_update" ON public.farms FOR UPDATE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = farms.project_id AND p.user_id = auth.uid()
    )
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
      SELECT 1 FROM public.projects p
      WHERE p.id = farms.project_id AND p.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = farms.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'editor')
    )
  );

-- ========================================================================
-- 4. farm_id を持つテーブル群を一括設定
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
  -- インライン展開する SQL 断片（farm_id を直接参照）
  view_using := $sql$
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = %1$I.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.id = f.project_id AND p.user_id = auth.uid()
          )
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
            SELECT 1 FROM public.projects p
            WHERE p.id = f.project_id AND p.user_id = auth.uid()
          )
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
-- 5. 孫テーブル: pipe_wiring_rows（group_id 経由で farms へ）
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
          JOIN public.farms f ON f.id = g.farm_id
          WHERE g.id = pipe_wiring_rows.group_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
-- 6. 孫テーブル: construction_plan_points（row_id 経由で farms へ）
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
          JOIN public.farms f ON f.id = r.farm_id
          WHERE r.id = construction_plan_points.row_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
-- 7. 孫テーブル: work_area_coordinates（work_area_id → design_work_areas → farms）
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
          JOIN public.farms f ON f.id = w.farm_id
          WHERE w.id = work_area_coordinates.work_area_id
            AND (
              f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
                SELECT 1 FROM public.projects p
                WHERE p.id = f.project_id AND p.user_id = auth.uid()
              )
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
