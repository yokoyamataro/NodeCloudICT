-- サイトオーナー（is_site_owner()）も project_members の管理ができるようにする。
--
-- 経緯:
--   20260602_project_members_owner_can_delete.sql で is_project_owner() を
--   「projects.user_id = auth.uid() OR project_members.role='owner'」と定義したが、
--   サイトオーナーアカウントで他ユーザーの工事のメンバー変更・削除を行うと
--   どちらの条件にも当てはまらず RLS で 0 行返却 → UI 上「権限がありません」。
--
--   また get_project_members も同じ判定で SECURITY DEFINER 内 RAISE しているため、
--   サイトオーナーが他人の工事のメンバー一覧すら開けなかった。
--
-- 方針:
--   ・is_project_owner() に is_site_owner() を OR で足す
--   ・get_project_members() のガードにも is_site_owner() を入れる
--   ・policy は 20260602 のものを DROP/再作成して確実に最新化（運用上、過去の
--     ポリシーが残っていてサイレントに弾かれる現象を防ぐ）
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

-- ========================================================================
-- 1. is_project_owner: サイトオーナーも owner 扱い
-- ========================================================================
CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = p_project_id AND p.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = p_project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_project_owner(uuid) TO authenticated;

-- ========================================================================
-- 2. project_members の管理系ポリシーを最新化
--    （過去のポリシーが残っていると古い USING で弾かれるため、INSERT/UPDATE/
--    DELETE 系を一旦全 DROP してから作り直す。SELECT は触らない）
-- ========================================================================
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT polname
    FROM pg_policy
    WHERE polrelid = 'public.project_members'::regclass
      AND polcmd IN ('a', 'w', 'd')  -- INSERT / UPDATE / DELETE
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.project_members', rec.polname);
  END LOOP;
END $$;

CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT
  WITH CHECK (public.is_project_owner(project_id));

CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE
  USING (public.is_project_owner(project_id));

-- ========================================================================
-- 3. get_project_members: サイトオーナーも一覧取得可
-- ========================================================================
DROP FUNCTION IF EXISTS public.get_project_members(uuid);

CREATE OR REPLACE FUNCTION public.get_project_members(p_project_id uuid)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  updated_at timestamptz,
  email text,
  display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT public.is_site_owner()
     AND NOT EXISTS (
       SELECT 1 FROM public.projects p
       WHERE p.id = p_project_id AND p.user_id = uid
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.project_members pm
       WHERE pm.project_id = p_project_id AND pm.user_id = uid
     ) THEN
    RAISE EXCEPTION 'Not authorized to view members of this project';
  END IF;

  RETURN QUERY
    SELECT
      pm.id,
      pm.project_id,
      pm.user_id,
      pm.role::text,
      pm.created_at,
      pm.updated_at,
      au.email::text AS email,
      COALESCE(
        NULLIF(au.raw_user_meta_data->>'full_name', ''),
        NULLIF(au.raw_user_meta_data->>'name', ''),
        NULLIF(au.raw_user_meta_data->>'display_name', ''),
        NULLIF(SPLIT_PART(au.email::text, '@', 1), '')
      ) AS display_name
    FROM public.project_members pm
    LEFT JOIN auth.users au ON au.id = pm.user_id
    WHERE pm.project_id = p_project_id
    ORDER BY pm.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_members(uuid) TO authenticated;
