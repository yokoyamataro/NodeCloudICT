-- 現場 (projects) / 工区 (farms) の soft-delete + ゴミ箱運用
--
-- 方針:
--   - 削除は DELETE ではなく UPDATE deleted_at = now() で行う
--   - 通常の一覧クエリはアプリ側で .is('deleted_at', null) を付けて除外
--   - ゴミ箱ビューでは deleted_at IS NOT NULL を対象に表示 (残り日数付き)
--   - 保持期間経過後は purge_expired_trash() で物理削除する
--     (attachments / storage オブジェクトの掃除はアプリ側の
--      permanent-delete フローに任せるので、この SQL は DB 行だけ落とす)
--
-- RLS はいじらない (deleted_at IS NULL フィルタは全てアプリ側で行う)。
-- これで既存メンバーは自分の削除したものをゴミ箱で確認できる。

-- ============================================================
-- 1. deleted_at カラム追加
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 通常フローで最も多いクエリ ("生存中" の取得) を高速化する部分インデックス。
-- ゴミ箱側は行数が少ないのでスキャンで十分。
CREATE INDEX IF NOT EXISTS idx_projects_alive
  ON public.projects(created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_farms_alive
  ON public.farms(project_id, updated_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 2. 保持期間経過分の物理削除関数
--    retention_days は 7 日を既定。将来ユーザー設定で変えられるように引数化。
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_expired_trash(retention_days INT DEFAULT 7)
RETURNS TABLE (deleted_projects INT, deleted_farms INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff TIMESTAMPTZ := now() - make_interval(days => retention_days);
  n_proj INT;
  n_farm INT;
BEGIN
  -- 先に farms を落として、参照制約でロックが取れない事故を避ける。
  -- (projects の CASCADE で farms も落ちるが、ここは deleted_at で個別管理してるので
  --  farms → projects の順で消す)
  WITH d AS (
    DELETE FROM public.farms
    WHERE deleted_at IS NOT NULL AND deleted_at < cutoff
    RETURNING 1
  )
  SELECT count(*) INTO n_farm FROM d;

  WITH d AS (
    DELETE FROM public.projects
    WHERE deleted_at IS NOT NULL AND deleted_at < cutoff
    RETURNING 1
  )
  SELECT count(*) INTO n_proj FROM d;

  RETURN QUERY SELECT n_proj, n_farm;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_trash(INT) TO authenticated;

COMMENT ON FUNCTION public.purge_expired_trash(INT) IS
  '保持期間を超えたゴミ箱内の projects/farms を物理削除する。retention_days で日数指定 (既定 7)。attachments/Storage の掃除は含まない。';

-- ============================================================
-- 3. (任意) pg_cron スケジュール例
--    Supabase Pro 以上で pg_cron が有効なら以下を実行するとよい。
--    毎日 03:00 UTC (日本時間正午) に retention_days=7 で実行。
--    ローカル / Free プランでは無効化されているので、必要時に手動で
--    SELECT public.purge_expired_trash(7); を呼んでください。
-- ============================================================

-- SELECT cron.schedule(
--   'purge_expired_trash_daily',
--   '0 3 * * *',
--   $$SELECT public.purge_expired_trash(7);$$
-- );
