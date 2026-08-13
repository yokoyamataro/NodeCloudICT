-- ============================================================
-- 20260813a_land_report_tables で追加した RLS を修正:
-- SELECT ポリシーで inline に organization_members を参照すると
-- organization_members 自身の RLS ポリシーと 相互再帰して
-- "infinite recursion detected in policy for relation organization_members" が発生。
--
-- 対策:
--   1) SECURITY DEFINER の is_member_of_org(org_id, uid) を新設
--   2) organization_surveyors / organization_report_snippets の SELECT ポリシーを
--      inline EXISTS → is_member_of_org 呼出に置換
-- ============================================================

-- is_org_admin(uid) と同じパターンで、対象組織のメンバー (admin/member 問わず) 判定を
-- SECURITY DEFINER の関数として提供する。関数内は search_path=public で
-- 実行され、呼出者の RLS はバイパスされるため 再帰しない。
CREATE OR REPLACE FUNCTION public.is_member_of_org(
  org_id uuid,
  uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = uid
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_member_of_org(uuid, uuid) TO authenticated;

-- ---- organization_surveyors: SELECT ポリシーを is_member_of_org で書換 ----
DROP POLICY IF EXISTS "org_surveyors_select" ON public.organization_surveyors;
CREATE POLICY "org_surveyors_select" ON public.organization_surveyors
  FOR SELECT TO authenticated
  USING (public.is_member_of_org(organization_id));

-- ---- organization_report_snippets: 同上 ----
DROP POLICY IF EXISTS "org_snippets_select" ON public.organization_report_snippets;
CREATE POLICY "org_snippets_select" ON public.organization_report_snippets
  FOR SELECT TO authenticated
  USING (public.is_member_of_org(organization_id));

-- INSERT/UPDATE/DELETE は public.is_admin_of_org() (既に SECURITY DEFINER) を
-- 使っているので 再帰しない (修正不要)。
