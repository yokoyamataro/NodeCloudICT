-- ============================================================
-- vehicle_assignments の SELECT ポリシーに「本人 (user_id = auth.uid())」を追加
--
-- 背景:
--   ドライバーが行き先を更新するとき、client は
--     .update(...).eq('id', ...).select().single()
--   を発行する。UPDATE 自体は user_id = auth.uid() で通るが、
--   post-UPDATE RETURNING の SELECT は SELECT ポリシー
--   (is_org_member_of_vehicle) を要求する。
--   organization_members に居ないドライバー (電話招待の未完了 or 現場割当のみ)
--   だと 0 rows が返り PGRST116 になっていた。
--
--   本人は常に自分の assignment を読めるようにする (書けるなら読めて当然)。
-- ============================================================

DROP POLICY IF EXISTS vehicle_assignments_select ON public.vehicle_assignments;
CREATE POLICY vehicle_assignments_select ON public.vehicle_assignments FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member_of_vehicle(vehicle_id)
    OR user_id = auth.uid()
  );
