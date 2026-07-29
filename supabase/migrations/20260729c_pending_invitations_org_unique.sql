-- pending_invitations の組織用 UNIQUE 索引を追加 + 既存重複行を dedupe。
--
-- 経緯:
--   pending_invitations は元々プロジェクト招待用で UNIQUE (project_id, email) が
--   張られていた。20260713c で organization_id 列を後から追加した際、対応する
--   UNIQUE を張り忘れ、組織招待では INSERT が毎回成功して同一 (org_id, email) の
--   pending 行が溜まる状態になっていた。
--   実測では 5 分で 5-7 行の重複が発生。今回 Edge Function を UPSERT 化する
--   にあたって、この UNIQUE を張る必要がある。
--
-- 追加/変更:
--   1. 既存の重複行を除去 (同一 org_id + email なら最新 1 行だけ残す)
--   2. 部分 UNIQUE 索引 pending_invitations_org_email_uidx を作成
--      (organization_id IS NOT NULL の行のみ対象)
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. 重複行の削除 (同一 org_id + email から最新以外を落とす)
-- ============================================================
DELETE FROM public.pending_invitations pi1
USING public.pending_invitations pi2
WHERE pi1.organization_id IS NOT NULL
  AND pi1.organization_id = pi2.organization_id
  AND pi1.email = pi2.email
  AND pi1.created_at < pi2.created_at;

-- ============================================================
-- 2. 部分 UNIQUE 索引
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS pending_invitations_org_email_uidx
  ON public.pending_invitations (organization_id, email)
  WHERE organization_id IS NOT NULL;
