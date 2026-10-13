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

-- ============================================================
-- H5: orthophoto-tiles Storage の 書き込み を 工区 編集権限 で 絞る
-- ============================================================
-- 旧 ポリシー は bucket_id='orthophoto-tiles' 全開 で、 他 工区 の タイル を
-- 認証ユーザー なら 誰でも 上書き できた。 パス 先頭 セグメント を farm_id
-- (UUID) と して is_farm_editor で 絞る。
-- bucket 自体 は public の まま (公開 URL で 誰でも 閲覧可)。

-- UUID キャスト を 安全 に (非 UUID は false) 行う 補助 関数。 他 の bucket
-- も 使い回せる 想定 で public に 置く。
CREATE OR REPLACE FUNCTION public.try_uuid(txt text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN txt::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP POLICY IF EXISTS "orthophoto_tiles_insert" ON storage.objects;
CREATE POLICY "orthophoto_tiles_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'orthophoto-tiles'
    AND public.is_farm_editor(public.try_uuid((storage.foldername(name))[1]))
  );

DROP POLICY IF EXISTS "orthophoto_tiles_update" ON storage.objects;
CREATE POLICY "orthophoto_tiles_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'orthophoto-tiles'
    AND public.is_farm_editor(public.try_uuid((storage.foldername(name))[1]))
  )
  WITH CHECK (
    bucket_id = 'orthophoto-tiles'
    AND public.is_farm_editor(public.try_uuid((storage.foldername(name))[1]))
  );

DROP POLICY IF EXISTS "orthophoto_tiles_delete" ON storage.objects;
CREATE POLICY "orthophoto_tiles_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'orthophoto-tiles'
    AND public.is_farm_editor(public.try_uuid((storage.foldername(name))[1]))
  );

NOTIFY pgrst, 'reload schema';
