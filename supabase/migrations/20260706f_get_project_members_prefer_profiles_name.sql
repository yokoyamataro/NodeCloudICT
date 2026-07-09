-- get_project_members の display_name を profiles.full_name 優先に変更する。
--
-- 背景:
--   これまで auth.users.raw_user_meta_data の full_name/name/display_name のみ
--   参照していた。OAuth プロバイダから氏名が来ないユーザー (メール+パスワード登録
--   や、Google でも名前を返さない構成) では最終フォールバックの
--   SPLIT_PART(email,'@',1) が使われ、UI 上 "yokoyama1980" のようなメール
--   ローカル部が表示されてしまっていた。
--
--   プロフィール画面で設定した public.profiles.full_name をまず参照するよう変更し、
--   list_share_candidates と同じ命名ロジックにそろえる。

DROP FUNCTION IF EXISTS public.get_project_members(uuid);

CREATE OR REPLACE FUNCTION public.get_project_members(p_project_id uuid)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  updated_at timestamptz,
  email text,
  display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = uid
  ) AND NOT EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = uid
  ) THEN
    RAISE EXCEPTION 'Not authorized to view members of this project';
  END IF;

  RETURN QUERY
    SELECT
      pm.id,
      pm.project_id,
      pm.user_id,
      pm.role::text,
      pm.created_at,
      pm.updated_at,
      au.email::text AS email,
      COALESCE(
        -- ユーザーがプロフィール画面で設定した氏名を最優先
        NULLIF(prof.full_name, ''),
        -- 次に OAuth プロバイダから来たメタデータ
        NULLIF(au.raw_user_meta_data->>'full_name', ''),
        NULLIF(au.raw_user_meta_data->>'name', ''),
        NULLIF(au.raw_user_meta_data->>'display_name', ''),
        -- 最後の手段としてメールローカル部
        NULLIF(SPLIT_PART(au.email::text, '@', 1), '')
      ) AS display_name
    FROM public.project_members pm
    LEFT JOIN auth.users au ON au.id = pm.user_id
    LEFT JOIN public.profiles prof ON prof.user_id = pm.user_id
    WHERE pm.project_id = p_project_id
    ORDER BY pm.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_members(uuid) TO authenticated;
