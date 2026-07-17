-- Fix: 登記認証情報の RPC が pgp_sym_encrypt / pgp_sym_decrypt を
-- 見つけられない (Supabase では extensions スキーマにあるが、search_path が
-- public, pg_temp のみだった)。extensions を search_path に追加する。
--
-- 併せて vault スキーマも明示 (念のため、vault.decrypted_secrets の解決用)。

-- 保存
CREATE OR REPLACE FUNCTION public.save_registry_credentials(
  p_username TEXT,
  p_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, pg_temp
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
     now())
  ON CONFLICT (user_id) DO UPDATE
    SET username_encrypted = EXCLUDED.username_encrypted,
        password_encrypted = EXCLUDED.password_encrypted,
        updated_at = now();
END;
$$;

-- 取得
CREATE OR REPLACE FUNCTION public.get_registry_credentials()
RETURNS TABLE (username TEXT, password TEXT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault, pg_temp
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
    RAISE EXCEPTION 'encryption key not initialized in vault';
  END IF;
  RETURN QUERY
    SELECT
      pgp_sym_decrypt(c.username_encrypted, v_key)::TEXT,
      pgp_sym_decrypt(c.password_encrypted, v_key)::TEXT,
      c.updated_at
    FROM public.user_registry_credentials c
    WHERE c.user_id = v_uid;
END;
$$;

-- 存在確認 (encryption 不要、search_path 修正のためついでに再定義)
CREATE OR REPLACE FUNCTION public.has_registry_credentials()
RETURNS TABLE (exists_flag BOOLEAN, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  RETURN QUERY
    SELECT TRUE, c.updated_at
    FROM public.user_registry_credentials c
    WHERE c.user_id = v_uid
    UNION ALL
    SELECT FALSE, NULL::TIMESTAMPTZ
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_registry_credentials WHERE user_id = v_uid
    )
    LIMIT 1;
END;
$$;

-- 削除
CREATE OR REPLACE FUNCTION public.delete_registry_credentials()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  DELETE FROM public.user_registry_credentials WHERE user_id = v_uid;
END;
$$;

-- 権限確認 (念のため)
GRANT EXECUTE ON FUNCTION public.save_registry_credentials(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_registry_credentials() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_registry_credentials() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_registry_credentials() TO authenticated;
