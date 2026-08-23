-- 座標の ソフト削除 + 30 日 復元機能
--
-- 変更内容:
--   1. design_coordinates に deleted_at / deleted_by 追加
--   2. 通常の取得は deleted_at IS NULL の 行だけ返すよう クライアント側 で フィルタ
--   3. 30 日経過した soft-deleted 行は 自動で 物理削除 (pg_cron)
--
-- クライアント側 変更 (別途 コード修正済み):
--   - deleteCoordinate: DELETE ではなく UPDATE deleted_at=NOW()
--   - restoreCoordinate: UPDATE deleted_at=NULL
--   - fetchCoordinates: WHERE deleted_at IS NULL
--   - fetchDeletedCoordinates: WHERE deleted_at IS NOT NULL
--
-- ロールバック方法:
--   ALTER TABLE design_coordinates DROP COLUMN deleted_at, DROP COLUMN deleted_by;
--   -- pg_cron ジョブは 手動で unschedule

BEGIN;

-- 1. カラム追加 (存在チェック で 冪等に)
ALTER TABLE public.design_coordinates
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. インデックス: soft-deleted のみを 引く用 (partial index で 通常 select は 影響なし)
CREATE INDEX IF NOT EXISTS design_coordinates_deleted_at_idx
  ON public.design_coordinates(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 既存の (farm_id, point_number) 一意制約が ある場合、soft-delete された 同名点番と
-- 新規追加時が 競合しないよう、UNIQUE を partial (WHERE deleted_at IS NULL) に する必要が
-- あるかもしれない。以下 コメントアウトで 提示 (現状 UNIQUE 制約無しなら 不要)
-- DROP INDEX IF EXISTS design_coordinates_farm_pn_idx;
-- CREATE UNIQUE INDEX design_coordinates_farm_pn_idx
--   ON public.design_coordinates(farm_id, point_number)
--   WHERE deleted_at IS NULL;

-- 3. RLS ポリシーは 既存の 'Users can access coordinates via project' 等が deleted_at に
-- 関わらず 全行 (含む soft-deleted) を 権限判定する ので 変更不要。
-- クライアント側で 通常取得は deleted_at IS NULL フィルタを かけるため、
-- ユーザーは 削除した 座標を 復元画面で 見られるが、他人の物は 見えない (project/farm 所属で 判定)。

-- 4. 30 日経過の 物理削除 (pg_cron が 有効な 環境で)
--    pg_cron が 有効かは Supabase Dashboard > Database > Extensions で 確認。
--    まだ 有効化してなければ:
--      CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- 以下 は 有効化 済みの 前提。 未有効化なら 手動で 定期的に 実行 or Supabase Scheduled
-- Functions で 代替。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- 既存の ジョブを 落として 再登録 (冪等)
    PERFORM cron.unschedule('purge_soft_deleted_coordinates')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_soft_deleted_coordinates');
    PERFORM cron.schedule(
      'purge_soft_deleted_coordinates',
      '0 3 * * *',  -- 毎日 03:00 (UTC)
      $CRON$
        DELETE FROM public.design_coordinates
        WHERE deleted_at IS NOT NULL
          AND deleted_at < NOW() - INTERVAL '30 days';
      $CRON$
    );
  END IF;
END $$;

COMMIT;
