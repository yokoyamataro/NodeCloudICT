-- 管理者 (admin) / 子ユーザー (child) の階層をサポートするため、profiles に
-- parent_user_id / plan / child_user_limit を追加する。
--
-- 階層モデル:
--   ・サイトオーナー (is_site_owner()): 全権限
--   ・管理者ユーザー: parent_user_id IS NULL のプロフィール
--     ・自身の plan の範囲内で工事を作れる
--     ・child_user_limit の範囲内で子ユーザーを追加できる
--   ・子ユーザー: parent_user_id が親の uid に設定されたプロフィール
--     ・親の plan を継承（参照時に lookup）
--     ・親の全工事に viewer で自動参加（Edge Function 側で project_members に追加）
--
-- 既存ユーザーは全員 parent_user_id IS NULL のままなので、自動的に「管理者」扱いになる。
-- plan / child_user_limit はサイトオーナーが /admin/users から個別に設定する想定。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

-- ========================================================================
-- 1. 列追加
-- ========================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS parent_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS plan text,
  ADD COLUMN IF NOT EXISTS child_user_limit integer;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_plan_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_plan_check
  CHECK (plan IS NULL OR plan IN ('cadastral', 'civil', 'total'));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_child_limit_nonneg;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_child_limit_nonneg
  CHECK (child_user_limit IS NULL OR child_user_limit >= 0);

CREATE INDEX IF NOT EXISTS idx_profiles_parent
  ON public.profiles (parent_user_id);

-- ========================================================================
-- 2. RLS: 親（admin）は自分の子ユーザーの profiles 行を SELECT できる
-- ========================================================================
DROP POLICY IF EXISTS profiles_select_parent ON public.profiles;
CREATE POLICY profiles_select_parent ON public.profiles FOR SELECT
  TO authenticated
  USING (parent_user_id = auth.uid());

-- 子の作成 / 削除は Edge Function 経由（service_role）で行うため、ここでは
-- INSERT/DELETE/UPDATE 用の親向けポリシーは置かない（サイトオーナー権限の
-- profiles_*_admin で全行操作可能）。

-- ========================================================================
-- 3. サイトオーナー用 RPC: ユーザー一覧 v2
--    既存 admin_list_users にカラムが増えただけなので、戻り値を拡張した
--    シグネチャに置き換える。
-- ========================================================================
DROP FUNCTION IF EXISTS public.admin_list_users();

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  organization_id uuid,
  organization_name text,
  parent_user_id uuid,
  parent_email text,
  plan text,
  child_user_limit integer,
  child_user_count integer,
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
      p.parent_user_id,
      pu.email::text AS parent_email,
      p.plan,
      p.child_user_limit,
      (
        SELECT COUNT(*)::int
        FROM public.profiles cp
        WHERE cp.parent_user_id = u.id
      ) AS child_user_count,
      u.last_sign_in_at,
      u.created_at
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.user_id = u.id
    LEFT JOIN public.organizations o ON o.id = p.organization_id
    LEFT JOIN auth.users pu ON pu.id = p.parent_user_id
    ORDER BY u.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;

-- ========================================================================
-- 4. サイトオーナー用 RPC: プロフィール upsert v2（plan / child_user_limit 追加）
-- ========================================================================
DROP FUNCTION IF EXISTS public.admin_upsert_profile(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.admin_upsert_profile(
  p_user_id uuid,
  p_full_name text,
  p_organization_id uuid,
  p_plan text DEFAULT NULL,
  p_child_user_limit integer DEFAULT NULL
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

  INSERT INTO public.profiles (user_id, full_name, organization_id, plan, child_user_limit)
  VALUES (p_user_id, p_full_name, p_organization_id, p_plan, p_child_user_limit)
  ON CONFLICT (user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        organization_id = EXCLUDED.organization_id,
        plan = EXCLUDED.plan,
        child_user_limit = EXCLUDED.child_user_limit,
        updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_profile(uuid, text, uuid, text, integer) TO authenticated;

-- ========================================================================
-- 5. 親（admin）用 RPC: 自分の子ユーザー一覧 + email + 状態
-- ========================================================================
CREATE OR REPLACE FUNCTION public.list_my_child_users()
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
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
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
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.user_id
    LEFT JOIN public.organizations o ON o.id = p.organization_id
    WHERE p.parent_user_id = caller
    ORDER BY u.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_child_users() TO authenticated;

-- ========================================================================
-- 6. 親（admin）用 RPC: 自分のプロフィール（plan / 上限 / 子ユーザー数）
-- ========================================================================
CREATE OR REPLACE FUNCTION public.get_my_admin_summary()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  plan text,
  child_user_limit integer,
  child_user_count integer,
  parent_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
    SELECT
      u.id AS user_id,
      u.email::text AS email,
      p.full_name,
      p.plan,
      p.child_user_limit,
      (
        SELECT COUNT(*)::int
        FROM public.profiles cp
        WHERE cp.parent_user_id = u.id
      ) AS child_user_count,
      p.parent_user_id
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.user_id = u.id
    WHERE u.id = caller;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_admin_summary() TO authenticated;
