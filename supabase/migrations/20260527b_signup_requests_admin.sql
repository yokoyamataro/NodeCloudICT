-- signup_requests の閲覧・更新を管理者（特定メール）のみに制限する。
-- 申し込み（INSERT）は引き続き誰でも可（フォーム送信）。
-- ※ 管理者を増やす場合はこのメール条件を編集（IN (...) にする）。

DROP POLICY IF EXISTS signup_requests_select ON public.signup_requests;
CREATE POLICY signup_requests_select ON public.signup_requests
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'email') = 'yokoyama1980@gmail.com');

DROP POLICY IF EXISTS signup_requests_update ON public.signup_requests;
CREATE POLICY signup_requests_update ON public.signup_requests
  FOR UPDATE TO authenticated
  USING ((auth.jwt() ->> 'email') = 'yokoyama1980@gmail.com')
  WITH CHECK ((auth.jwt() ->> 'email') = 'yokoyama1980@gmail.com');

GRANT UPDATE ON public.signup_requests TO authenticated;
