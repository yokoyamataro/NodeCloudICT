-- 20260729c の部分 UNIQUE 索引を通常 UNIQUE 索引に置き換える。
--
-- 経緯:
--   20260729c で `WHERE organization_id IS NOT NULL` の部分 UNIQUE 索引を張ったが、
--   PostgreSQL の `ON CONFLICT (organization_id, email)` は WHERE 付きの部分索引を
--   同じ WHERE を明示しないと arbiter として推論できず、PostgREST の upsert から
--   ↓のエラーで失敗する:
--     "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- 対応:
--   非部分の UNIQUE 索引 (organization_id, email) に張り直す。
--   PostgreSQL の default (NULLS DISTINCT) により、project_id 側の
--   organization_id=NULL 行は「別々」と扱われるので、project 招待 (organization_id=NULL)
--   同士は衝突しない。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- 既存の部分索引を落とす
DROP INDEX IF EXISTS public.pending_invitations_org_email_uidx;

-- 念のため dedupe (20260729c で実施済のはずだが冪等に)
DELETE FROM public.pending_invitations pi1
USING public.pending_invitations pi2
WHERE pi1.organization_id IS NOT NULL
  AND pi1.organization_id = pi2.organization_id
  AND pi1.email = pi2.email
  AND pi1.created_at < pi2.created_at;

-- 非部分 UNIQUE 索引を張り直す
CREATE UNIQUE INDEX IF NOT EXISTS pending_invitations_org_email_uidx
  ON public.pending_invitations (organization_id, email);
