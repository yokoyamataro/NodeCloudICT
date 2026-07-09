-- 現場 (projects) に共有ポリシーを 3 段階 (占有/共有/公開) で持たせる。
--
-- 用途:
--   private (占有): 所有者のみ閲覧・編集
--   shared  (共有): 所有者 + project_members に登録された共有ユーザー
--                   閲覧・編集 (member.role で editor/viewer 判定)
--   public  (公開): 誰でも (anon 含む) 閲覧のみ。編集は所有者 + editor のみ
--
-- 既存 projects 行は 'shared' を既定値にすることで従来挙動を維持する。

-- ============================================================
-- 1. project_visibility 型の作成 (冪等)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_visibility') THEN
    CREATE TYPE public.project_visibility AS ENUM ('private', 'shared', 'public');
  END IF;
END $$;

-- ============================================================
-- 2. projects.visibility 列の追加
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS visibility project_visibility NOT NULL DEFAULT 'shared';

-- ============================================================
-- 3. SELECT ポリシーの差し替え (公開現場は認証なしでも閲覧可能)
-- ============================================================
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects FOR SELECT
  USING (
    -- 公開現場: anon 含めて全員閲覧可
    visibility = 'public'
    -- 所有者
    OR user_id = auth.uid()
    -- 共有メンバー (visibility='shared' でなくても member テーブルにいれば読める
    --   → private に戻したら owner が手動で member を削除する運用)
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id AND pm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 4. farms SELECT (公開現場配下の farms は誰でも閲覧可)
-- ============================================================
DROP POLICY IF EXISTS "farms_select" ON public.farms;
CREATE POLICY "farms_select" ON public.farms FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = farms.project_id
        AND (
          p.visibility = 'public'
          OR p.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
          )
        )
    )
  );

-- ============================================================
-- 5. farm 配下テーブルの SELECT ポリシーを差し替え
--    (公開現場の閲覧を含めるため、既存の "farm.user_id or member" 条件に
--     projects.visibility='public' も加える)
-- ============================================================
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

    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format($sql$
      CREATE POLICY "%1$s_select" ON public.%1$I FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.farms f
          JOIN public.projects p ON p.id = f.project_id
          WHERE f.id = %1$I.farm_id
            AND (
              p.visibility = 'public'
              OR f.user_id = auth.uid()
              OR EXISTS (
                SELECT 1 FROM public.project_members pm
                WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              )
            )
        )
      )
    $sql$, t);
  END LOOP;
END $$;

-- ============================================================
-- 6. anon ロールにも SELECT を通す GRANT (RLS が最終ゲート)
--    Supabase の RLS は enable でも GRANT は別なので明示付与
-- ============================================================
GRANT SELECT ON public.projects TO anon;
GRANT SELECT ON public.farms TO anon;

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'design_coordinates', 'design_pipes',
    'design_survey_data', 'design_survey_calibration',
    'design_work_areas', 'design_coordinate_routes',
    'pipe_wiring_groups', 'construction_plan_rows'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 7. list_share_candidates を「社内メンバー + 過去に共有した外部メンバー」対応に更新
--    戻り値に is_internal を追加。
--    - 社内メンバー: 呼び出し元と同じ organization_id のプロフィール
--    - 外部メンバー: 呼び出し元が所有するプロジェクトに参加中の外部ユーザー
--                   (= 呼び出し元が「共有したことがある」ユーザー)
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_share_candidates()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  is_internal boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  caller uuid := auth.uid();
  caller_org uuid;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT organization_id INTO caller_org
    FROM public.profiles WHERE user_id = caller;

  RETURN QUERY
    WITH shared_external AS (
      -- 呼び出し元が過去に自分のプロジェクトへ招待した外部ユーザーの user_id 集合
      SELECT DISTINCT pm.user_id AS uid
      FROM public.project_members pm
      JOIN public.projects pr ON pr.id = pm.project_id
      WHERE pr.user_id = caller AND pm.user_id <> caller
    )
    SELECT
      u.id AS user_id,
      u.email::text AS email,
      prof.full_name AS full_name,
      (caller_org IS NOT NULL AND prof.organization_id = caller_org) AS is_internal
    FROM auth.users u
    LEFT JOIN public.profiles prof ON prof.user_id = u.id
    WHERE u.id <> caller
      AND (
        -- 社内 (同一組織)
        (caller_org IS NOT NULL AND prof.organization_id = caller_org)
        -- 過去に共有した外部ユーザー
        OR EXISTS (SELECT 1 FROM shared_external s WHERE s.uid = u.id)
        -- サイトオーナーは全ユーザーを候補にできる
        OR public.is_site_owner()
      )
    ORDER BY 4 DESC, 2;  -- 社内を先に、そのあと email 昇順
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_share_candidates() TO authenticated;
