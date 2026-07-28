-- list_share_candidates を organization_members ベースに書き換える。
--
-- 経緯:
--   20260706e で書いた版は「同一組織」判定を profiles.organization_id で行っていた。
--   しかし現行の組織メンバー管理 UI から追加された既存ユーザーは
--   organization_members には INSERT されるが profiles.organization_id が
--   NULL のまま残るケースがある (invite-member Edge Function の profiles upsert
--   が RLS で弾かれた場合 / 過去に作成されたプロファイル等)。
--   結果、「組織・メンバー管理」画面には 5 名映っているのに
--   現場の編集モーダルの「組織内」プルダウンには誰も出ない、という食い違いが発生する。
--
-- 方針:
--   組織メンバーシップの権威ソースを organization_members に統一する。
--   list_share_candidates もそちらを参照するように変更。
--   (profiles.organization_id は表示用途に残す)
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

DROP FUNCTION IF EXISTS public.list_share_candidates();

CREATE OR REPLACE FUNCTION public.list_share_candidates()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  is_internal boolean
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
    WITH caller_orgs AS (
      -- 呼び出し元が属する組織 (organization_members が権威ソース)
      SELECT om.organization_id AS org_id
      FROM public.organization_members om
      WHERE om.user_id = caller
    ),
    internal_users AS (
      -- 同じ組織に属するユーザー (呼び出し元自身は除く)
      SELECT DISTINCT om.user_id AS uid
      FROM public.organization_members om
      JOIN caller_orgs co ON co.org_id = om.organization_id
      WHERE om.user_id <> caller
    ),
    shared_external AS (
      -- 呼び出し元が過去に自分のプロジェクトへ招待した外部ユーザー
      SELECT DISTINCT pm.user_id AS uid
      FROM public.project_members pm
      JOIN public.projects pr ON pr.id = pm.project_id
      WHERE pr.user_id = caller AND pm.user_id <> caller
    )
    SELECT
      u.id,
      u.email::text,
      prof.full_name,
      EXISTS (SELECT 1 FROM internal_users i WHERE i.uid = u.id) AS is_internal
    FROM auth.users u
    LEFT JOIN public.profiles prof ON prof.user_id = u.id
    WHERE u.id <> caller
      AND (
        EXISTS (SELECT 1 FROM internal_users i WHERE i.uid = u.id)
        OR EXISTS (SELECT 1 FROM shared_external s WHERE s.uid = u.id)
        OR public.is_site_owner()
      )
    ORDER BY 4 DESC, 2;  -- 社内 (is_internal=true) が先、そのあと email 昇順
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_share_candidates() TO authenticated;
