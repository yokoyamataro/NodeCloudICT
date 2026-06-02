-- project_members の管理権限を「プロジェクト作成者 OR project_members.role='owner'」に拡張。
--
-- 経緯:
--   従来 (20260425_member_based_rls_fix4) は projects.user_id のみが
--   project_members を INSERT / UPDATE / DELETE できる設計だった。
--   しかし UI / アプリ仕様では role='owner' のメンバーもオーナーとして
--   メンバー管理ができる前提になっており、追加オーナーが DELETE しても
--   サイレントに 0 行返り、「ユーザーが消えない」現象が起きていた。
--
-- 方針:
--   SECURITY DEFINER 関数 is_project_owner(uuid) で「creator OR role='owner'」を
--   判定し、INSERT / UPDATE / DELETE ポリシーから呼ぶ。
--   SECURITY DEFINER で RLS をバイパスして project_members を見るため、
--   過去の 42P17（再帰）も発生しない。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行。

-- ========================================================================
-- 1. オーナー判定関数（SECURITY DEFINER で RLS バイパス）
-- ========================================================================
CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (
    EXISTS (
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
-- 2. project_members の管理系ポリシーを置き換え
--    SELECT は従来通り user_id = auth.uid() （クロス参照ゼロ）。
--    一覧表示は SECURITY DEFINER の get_project_members RPC 経由のまま。
-- ========================================================================
-- 過去の名残ポリシー（"Users can ..." 系など）が残っているとそちらが優先される
-- ことがあるため、project_members の SELECT 以外のポリシーを一旦全部 DROP して
-- から綺麗に作り直す。
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT polname, polcmd
    FROM pg_policy
    WHERE polrelid = 'public.project_members'::regclass
      AND polcmd IN ('a', 'w', 'd')  -- INSERT / UPDATE / DELETE のみ
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.project_members', rec.polname);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_update" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;

CREATE POLICY "project_members_insert" ON public.project_members FOR INSERT
  WITH CHECK (public.is_project_owner(project_id));

CREATE POLICY "project_members_update" ON public.project_members FOR UPDATE
  USING (public.is_project_owner(project_id));

CREATE POLICY "project_members_delete" ON public.project_members FOR DELETE
  USING (public.is_project_owner(project_id));
