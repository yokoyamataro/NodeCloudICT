-- ============================================================
-- mobility_positions SELECT ポリシーを緩和 (admin / 本人 も明示許可)
--
-- 従来:
--   USING (is_site_owner() OR is_org_member_of_assignment(assignment_id))
--   is_org_member_of_assignment は 3 段 JOIN でメンバー判定していた:
--     mobility_positions → vehicle_assignments → vehicles → organization_members
--   何らかの理由 (組織メンバー登録漏れ、電話招待の中間状態、
--   将来の RLS 変更) でメンバー行が欠けると silent 0 rows になり、
--   admin から見て「位置未受信」表示になる事象を再現していた。
--
-- 対策 (vehicle_assignments で先に行った修正と同じ思想):
--   1. is_admin_of_org(vehicle.organization_id) を追加 (組織 admin は常に読める)
--   2. vehicle_assignments.user_id = auth.uid() を追加 (本人は自分の ping を常に読める)
--   is_org_member_of_assignment は残す (通常メンバー向け)
-- ============================================================

-- 補助関数: assignment に紐付く車両の組織で admin か
CREATE OR REPLACE FUNCTION public.is_org_admin_of_assignment(v_assignment_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicle_assignments a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    WHERE a.id = v_assignment_id
      AND public.is_admin_of_org(v.organization_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_admin_of_assignment(uuid) TO authenticated;

-- 補助関数: assignment の user_id が呼び出し元と一致するか
CREATE OR REPLACE FUNCTION public.is_own_assignment(v_assignment_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicle_assignments a
    WHERE a.id = v_assignment_id AND a.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_own_assignment(uuid) TO authenticated;

DROP POLICY IF EXISTS mobility_positions_select ON public.mobility_positions;
CREATE POLICY mobility_positions_select ON public.mobility_positions FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_admin_of_assignment(assignment_id)
    OR public.is_own_assignment(assignment_id)
    OR public.is_org_member_of_assignment(assignment_id)
  );
