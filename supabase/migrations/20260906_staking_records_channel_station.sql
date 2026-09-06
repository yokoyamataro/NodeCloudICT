-- 測設記録の target_type に 'channel_station' (線形物の 中間点) を 追加する。
--
-- 線形物の 中間点 (SP) は 中心線上の 距離で 定義される 点で、座標管理には
-- 登録されていない。これを 測設ターゲットに できるように したため、
-- 記録の 種別にも 追加する。target_ref_id には open_channels の
-- stations[].id が 入る。
--
-- Supabase SQL Editor で実行してください。

-- 既存の CHECK 制約 (名前が 環境で 違いうる) を 外してから 貼り直す
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.staking_records'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%target_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.staking_records DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.staking_records
  ADD CONSTRAINT staking_records_target_type_check
  CHECK (target_type IN ('coordinate', 'pipe_vertex', 'free', 'channel_station'));
