-- list_share_candidates() から profiles.parent_user_id 依存を除去。
--
-- 経緯:
--   20260702b で list_share_candidates() を作った際、profiles.parent_user_id
--   （20260605_add_child_users.sql で追加される列）を参照していたが、その
--   マイグレーションが未適用の環境で 42703 が発生してテンプレート管理モーダル
--   が開けなかった。
--
-- 方針:
--   共有候補は「同一組織のユーザー」or「サイトオーナーなら全員」に限定。
--   子ユーザー階層は今回の共有機能には必須でないので依存を落とす。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

CREATE OR REPLACE FUNCTION public.list_share_candidates()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  RETURN QUERY
    SELECT DISTINCT u.id, u.email::text, p.full_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.user_id = u.id
    WHERE u.id <> caller
      AND (
        -- サイトオーナーなら全員
        public.is_site_owner()
        -- 同一組織
        OR EXISTS (
          SELECT 1 FROM public.profiles me
          WHERE me.user_id = caller
            AND me.organization_id IS NOT NULL
            AND me.organization_id = p.organization_id
        )
      )
    ORDER BY u.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_share_candidates() TO authenticated;
