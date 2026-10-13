-- セキュリティ レビュー (2026-10-14) で 判明 した 高 深刻度 の RLS 緩さ を 修正。
--
-- H2: contact_messages — 全 authenticated が 問い合わせ 本文 (個人情報) を SELECT/UPDATE
--     できる 状態 を、 site_owner のみ 可 に 絞る。
-- H3: signup_requests — 全 authenticated が 申込 情報 (会社名/メアド/電話/要望) を
--     SELECT できる 状態 を、 site_owner のみ 可 に 絞る。

-- ============================================================
-- H2: contact_messages
-- ============================================================
DROP POLICY IF EXISTS contact_messages_select ON public.contact_messages;
CREATE POLICY contact_messages_select ON public.contact_messages
  FOR SELECT TO authenticated
  USING (public.is_site_owner());

DROP POLICY IF EXISTS contact_messages_update ON public.contact_messages;
CREATE POLICY contact_messages_update ON public.contact_messages
  FOR UPDATE TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

-- ============================================================
-- H3: signup_requests
-- ============================================================
-- 既存 ポリシー 名 は マイグレ 側 を 確認 して 揃える (下記 2 系統 の いずれか が 定義 済)
DROP POLICY IF EXISTS signup_requests_select ON public.signup_requests;
DROP POLICY IF EXISTS signup_requests_authenticated_select ON public.signup_requests;
CREATE POLICY signup_requests_select ON public.signup_requests
  FOR SELECT TO authenticated
  USING (public.is_site_owner());

DROP POLICY IF EXISTS signup_requests_update ON public.signup_requests;
CREATE POLICY signup_requests_update ON public.signup_requests
  FOR UPDATE TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

NOTIFY pgrst, 'reload schema';
