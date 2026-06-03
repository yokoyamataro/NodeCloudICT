-- アカウント単位のユーザー属性（profiles）と所属組織（organizations）を新設する。
--
-- 役割分担:
--   organizations: 契約・請求の単位として使う「会社/組織」マスタ。サイトオーナーのみ管理可能。
--   profiles     : auth.users と 1:1。フルネーム、所属組織、（将来）プランなどを保持する。
--                  本人は自分の行を SELECT のみ、サイトオーナーは全行 SELECT/UPDATE/INSERT/DELETE 可。
--
-- サイトオーナー判定は、フロントの ADMIN_EMAILS と同じく email で行う。
-- 現状は yokoyama1980@gmail.com のみ。将来増やすときはここの関数と admin.ts を両方更新する。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行。

-- ========================================================================
-- 0. サイトオーナー判定ヘルパー
-- ========================================================================
CREATE OR REPLACE FUNCTION public.is_site_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = auth.uid()
      AND lower(u.email) IN ('yokoyama1980@gmail.com')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_site_owner() TO authenticated;

-- ========================================================================
-- 1. organizations
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_select ON public.organizations;
DROP POLICY IF EXISTS organizations_insert ON public.organizations;
DROP POLICY IF EXISTS organizations_update ON public.organizations;
DROP POLICY IF EXISTS organizations_delete ON public.organizations;

-- 認証済みユーザーは一覧を引ける（プロジェクトメンバー一覧で組織名を出す等の用途）
CREATE POLICY organizations_select ON public.organizations FOR SELECT
  TO authenticated
  USING (true);

-- 書き込みはサイトオーナーのみ
CREATE POLICY organizations_insert ON public.organizations FOR INSERT
  TO authenticated
  WITH CHECK (public.is_site_owner());

CREATE POLICY organizations_update ON public.organizations FOR UPDATE
  TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

CREATE POLICY organizations_delete ON public.organizations FOR DELETE
  TO authenticated
  USING (public.is_site_owner());

-- updated_at を自動更新
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organizations_touch ON public.organizations;
CREATE TRIGGER trg_organizations_touch
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- 2. profiles
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_organization
  ON public.profiles (organization_id);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_self ON public.profiles;
DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
DROP POLICY IF EXISTS profiles_update_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_admin ON public.profiles;

-- 本人は自分の行のみ SELECT 可能
CREATE POLICY profiles_select_self ON public.profiles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- サイトオーナーは全行 SELECT 可能
CREATE POLICY profiles_select_admin ON public.profiles FOR SELECT
  TO authenticated
  USING (public.is_site_owner());

-- 本人は自分の full_name を更新できる（組織は管理者だけが付けられる方が安全なのでここでは触らせない）
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND organization_id IS NOT DISTINCT FROM (
    SELECT p.organization_id FROM public.profiles p WHERE p.user_id = auth.uid()
  ));

-- サイトオーナーは全行 UPDATE 可能
CREATE POLICY profiles_update_admin ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

CREATE POLICY profiles_insert_admin ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (public.is_site_owner() OR user_id = auth.uid());

CREATE POLICY profiles_delete_admin ON public.profiles FOR DELETE
  TO authenticated
  USING (public.is_site_owner());

DROP TRIGGER IF EXISTS trg_profiles_touch ON public.profiles;
CREATE TRIGGER trg_profiles_touch
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- 3. auth.users INSERT トリガ: 新規ユーザーに空の profiles 行を作る
-- ========================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
      NULLIF(NEW.raw_user_meta_data->>'name', ''),
      NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
      NULL
    )
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- ========================================================================
-- 4. 既存ユーザーの backfill
-- ========================================================================
INSERT INTO public.profiles (user_id, full_name)
SELECT
  u.id,
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'full_name', ''),
    NULLIF(u.raw_user_meta_data->>'name', ''),
    NULLIF(u.raw_user_meta_data->>'display_name', ''),
    NULL
  )
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- ========================================================================
-- 5. サイトオーナー用 RPC: ユーザー一覧（auth.users と JOIN）
-- ========================================================================
-- profiles の RLS だけだと auth.users の email を取れない。サイトオーナーが
-- 「全ユーザー（プロフィール未作成も含む）+ email + 所属組織」を一覧する用に
-- SECURITY DEFINER で固める。
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  organization_id uuid,
  organization_name text,
  last_sign_in_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT public.is_site_owner() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT
      u.id AS user_id,
      u.email::text AS email,
      p.full_name,
      p.organization_id,
      o.name AS organization_name,
      u.last_sign_in_at,
      u.created_at
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.user_id = u.id
    LEFT JOIN public.organizations o ON o.id = p.organization_id
    ORDER BY u.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;

-- ========================================================================
-- 6. サイトオーナー用 RPC: プロフィール upsert（一覧画面から編集する用）
-- ========================================================================
CREATE OR REPLACE FUNCTION public.admin_upsert_profile(
  p_user_id uuid,
  p_full_name text,
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_site_owner() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  INSERT INTO public.profiles (user_id, full_name, organization_id)
  VALUES (p_user_id, p_full_name, p_organization_id)
  ON CONFLICT (user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        organization_id = EXCLUDED.organization_id,
        updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_profile(uuid, text, uuid) TO authenticated;
