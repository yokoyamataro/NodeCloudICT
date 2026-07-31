-- 日をまたいだ稼働中割当を pg_cron で毎晩 00:05 JST に自動終了させる。
--
-- 背景:
--   ドライバーが降車ボタンを押し忘れて放置すると、翌日以降も乗車中扱いになり
--   走行距離集計・行き先・現在速度がおかしくなる。手動の「強制降車」もあるが
--   admin が気づかない可能性があるため、日付が変わった時点で自動でも降車させる。
--
-- 挙動:
--   ・JST 00:05 (UTC 15:05) にジョブが走る
--   ・started_at が「JST 今日 00:00」より前の 稼働中 (ended_at IS NULL) を対象
--   ・ended_at には「JST 今日 00:00」を刺す (乗車時間を日単位で集計しやすくする)
--   ・memo に「(日付跨ぎで自動降車)」を追記して、手動終了と区別できるように
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等)。
--   Supabase Pro 以上 (pg_cron 利用可) が前提。

-- pg_cron を有効化 (Supabase Dashboard の Extensions で ON でも同じ)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 既存ジョブがあれば消して登録し直し (冪等化)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-close-stale-vehicle-assignments') THEN
    PERFORM cron.unschedule('auto-close-stale-vehicle-assignments');
  END IF;
END $$;

-- JST 00:05 = UTC 15:05
SELECT cron.schedule(
  'auto-close-stale-vehicle-assignments',
  '5 15 * * *',
  $CRON$
    UPDATE public.vehicle_assignments
    SET ended_at = date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo',
        memo = CASE
          WHEN memo IS NULL OR memo = '' THEN '(日付跨ぎで自動降車)'
          ELSE memo || E'\n(日付跨ぎで自動降車)'
        END
    WHERE ended_at IS NULL
      AND started_at < date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo';
  $CRON$
);

COMMENT ON EXTENSION pg_cron IS
  'モビリティ機能: 日付跨ぎで放置された vehicle_assignments を自動終了するジョブに使用';
