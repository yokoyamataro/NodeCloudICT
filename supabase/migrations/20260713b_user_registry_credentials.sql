-- 登記情報提供サービス (touki.or.jp) の ID/PW をユーザーごとに
-- 暗号化して保存する。
--
-- セキュリティ設計:
--   * 実データ (BYTEA) は user_registry_credentials に格納。RLS は
--     「クライアント直接アクセス完全禁止」で、SECURITY DEFINER 関数
--     経由のみアクセス可。
--   * 対称鍵は Supabase Vault (vault.decrypted_secrets) に保管。
--     Vault はロールごとの権限管理があり、アプリロール (authenticated)
--     は直接読めない。関数の owner (postgres) だけが読める。
--   * SECURITY DEFINER 関数は auth.uid() で本人チェックしてから
--     暗号化 / 復号する。他人の資格情報は見えない。
--
-- 関連関数:
--   save_registry_credentials(username, password)
--   get_registry_credentials() -> (username, password, updated_at)
--   has_registry_credentials() -> (exists_flag, updated_at)
--   delete_registry_credentials()

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Vault に鍵が無ければランダムに生成。全ユーザーで共有する対称鍵。
DO $$
DECLARE
  v_secret_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'registry-credentials-key'
  ) THEN
    SELECT vault.create_secret(
      encode(gen_random_bytes(32), 'base64'),
      'registry-credentials-key',
      'Symmetric key for encrypting per-user registry (touki.or.jp) credentials'
    ) INTO v_secret_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_registry_credentials (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username_encrypted BYTEA NOT NULL,
  password_encrypted BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_registry_credentials ENABLE ROW LEVEL SECURITY;
-- ポリシー無し = クライアント側から直接 SELECT / INSERT できない。
-- 全て SECURITY DEFINER 関数経由。

-- ===== 保存 =====
CREATE OR REPLACE FUNCTION public.save_registry_credentials(
  p_username TEXT,
  p_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_key TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF coalesce(trim(p_username), '') = '' OR coalesce(p_password, '') = '' THEN
    RAISE EXCEPTION 'username / password required';
  END IF;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'registry-credentials-key';
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'encryption key not initialized in vault';
  END IF;
  INSERT INTO public.user_registry_credentials
    (user_id, username_encrypted, password_encrypted, updated_at)
  VALUES
    (v_uid,
     pgp_sym_encrypt(p_username, v_key),
     pgp_sym_encrypt(p_password, v_key),
     NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    username_encrypted = EXCLUDED.username_encrypted,
    password_encrypted = EXCLUDED.password_encrypted,
    updated_at = NOW();
END;
$$;

-- ===== 取得 (plaintext) =====
-- ユーザーが「登録内容を確認 / 編集」するときのみ呼ぶ想定。
CREATE OR REPLACE FUNCTION public.get_registry_credentials()
RETURNS TABLE (username TEXT, password TEXT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_key TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'registry-credentials-key';
  IF v_key IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    pgp_sym_decrypt(t.username_encrypted, v_key)::TEXT,
    pgp_sym_decrypt(t.password_encrypted, v_key)::TEXT,
    t.updated_at
  FROM public.user_registry_credentials t
  WHERE t.user_id = v_uid;
END;
$$;

-- ===== 存在確認 (plaintext 返さず) =====
-- ページ表示時に「登録済みか」だけ知りたいときに呼ぶ。
CREATE OR REPLACE FUNCTION public.has_registry_credentials()
RETURNS TABLE (exists_flag BOOLEAN, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT TRUE, t.updated_at
  FROM public.user_registry_credentials t
  WHERE t.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

-- ===== 削除 =====
CREATE OR REPLACE FUNCTION public.delete_registry_credentials()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  DELETE FROM public.user_registry_credentials WHERE user_id = auth.uid();
END;
$$;

-- ===== Grants =====
REVOKE ALL ON FUNCTION public.save_registry_credentials(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_registry_credentials() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_registry_credentials() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_registry_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_registry_credentials(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_registry_credentials() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_registry_credentials() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_registry_credentials() TO authenticated;
