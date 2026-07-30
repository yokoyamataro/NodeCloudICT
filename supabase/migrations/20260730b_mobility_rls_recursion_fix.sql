-- vehicles SELECT ポリシー内の organization_members 直接参照を SECURITY DEFINER
-- 関数経由に置き換え、RLS 無限再帰 (42P17) を回避する。
--
-- 経緯:
--   20260730 で vehicles_select を以下のように書いた:
--     USING (public.is_site_owner()
--            OR EXISTS (SELECT 1 FROM organization_members om WHERE ...))
--   しかし organization_members 自身の SELECT ポリシーが自テーブルへの
--   EXISTS 参照を含んでいるため、Postgres が循環検知して
--   "infinite recursion detected in policy for relation organization_members"
--   を出す。
--
--   すでに vehicles / assignments 用の SECURITY DEFINER ヘルパは作ってあった
--   (is_org_member_of_vehicle 等) が、vehicles テーブル自身の SELECT では
--   organization_id を直接持っているのでヘルパを呼びづらく、EXISTS を書いて
--   しまっていた。汎用の is_org_member(org_id) を新設して置き換える。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. 汎用ヘルパ is_org_member(org_id, uid)
--    SECURITY DEFINER で organization_members の RLS をバイパスして
--    「uid が org_id に所属しているか」を返す。
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_org_member(
  org_id uuid,
  uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id AND user_id = uid
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated;

-- ============================================================
-- 2. vehicles_select を差し替え (EXISTS → is_org_member)
-- ============================================================
DROP POLICY IF EXISTS vehicles_select ON public.vehicles;
CREATE POLICY vehicles_select ON public.vehicles FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member(organization_id)
  );
