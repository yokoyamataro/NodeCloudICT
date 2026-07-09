-- 子ユーザー (親/子階層) 機能を撤去する。
--
-- 経緯:
--   20260605_add_child_users.sql で入れた「管理者ユーザーが自分の子ユーザーを
--   追加できる」階層モデルは実運用で使わなくなった。
--   共有は projects.visibility + project_members で運用するため、profiles の
--   parent_user_id / plan / child_user_limit と、それを使う RPC 群は不要。
--
-- このマイグレーションで:
--   1. 子ユーザー関連 RPC を DROP
--   2. admin_list_users / admin_upsert_profile を「full_name + organization_id」
--      だけ扱う元のシグネチャに戻す
--   3. profiles.parent_user_id / plan / child_user_limit 列を DROP
--   4. RLS ポリシー profiles_select_parent を DROP
--
-- Edge Function admin-create-child-user / admin-delete-child-user は
-- Supabase Dashboard の Functions 画面から手動で削除すること。

-- ========================================================================
-- 1. 子ユーザー関連 RPC の削除
-- ========================================================================
DROP FUNCTION IF EXISTS public.list_my_child_users();
DROP FUNCTION IF EXISTS public.get_my_admin_summary();

-- ========================================================================
-- 2. admin_list_users を元のシグネチャに戻す
-- ========================================================================
DROP FUNCTION IF EXISTS public.admin_list_users();

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
-- 3. admin_upsert_profile を元のシグネチャに戻す
-- ========================================================================
DROP FUNCTION IF EXISTS public.admin_upsert_profile(uuid, text, uuid, text, integer);
DROP FUNCTION IF EXISTS public.admin_upsert_profile(uuid, text, uuid);

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

-- ========================================================================
-- 4. profiles の親/子・プラン関連列を削除
-- ========================================================================
DROP POLICY IF EXISTS profiles_select_parent ON public.profiles;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_plan_check,
  DROP CONSTRAINT IF EXISTS profiles_child_limit_nonneg;

DROP INDEX IF EXISTS public.idx_profiles_parent;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS parent_user_id,
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS child_user_limit;
