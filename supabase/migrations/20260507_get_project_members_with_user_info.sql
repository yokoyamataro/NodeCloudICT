-- get_project_members に email / display_name を返すよう拡張
-- 既存はメンバー一覧を SETOF project_members で返していたため email / 名前が取れず、
-- UI 側で user_id（UUID）が表示されてしまっていた。
-- auth.users と LEFT JOIN し、表示名を抽出して TABLE 形式で返すよう書き換える。
-- display_name は OAuth プロバイダ由来の full_name / name / display_name を順に試し、
-- 無ければ email のローカル部（@ より前）にフォールバック。

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
        NULLIF(au.raw_user_meta_data->>'full_name', ''),
        NULLIF(au.raw_user_meta_data->>'name', ''),
        NULLIF(au.raw_user_meta_data->>'display_name', ''),
        NULLIF(SPLIT_PART(au.email::text, '@', 1), '')
      ) AS display_name
    FROM public.project_members pm
    LEFT JOIN auth.users au ON au.id = pm.user_id
    WHERE pm.project_id = p_project_id
    ORDER BY pm.created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_members(uuid) TO authenticated;
