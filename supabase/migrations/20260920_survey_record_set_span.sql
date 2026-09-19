-- 実測記録セット に 開始日時 / 終了日時 を 持たせる。
--
-- スマホ で 作業 を 始める とき に セット を 選ぶ (または 作る) 運用 に した ので、
-- 「いつ 始めて いつ まで 測った セット か」 を セット 自身 が 持って いた 方 が
-- 後 から 追える。
--   started_at … その セット で 最初 に 測り 始めた 時刻 (選んだ / 作った 時点)
--   ended_at   … その セット に 最後 に 記録 が 入った 時刻
--
-- どちら も null 可。 既存 の セット は その セット の 記録 の 最初 / 最後 で 埋める。

ALTER TABLE public.survey_record_sets
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

COMMENT ON COLUMN public.survey_record_sets.started_at IS '作業 を 始めた 時刻 (セット を 選んだ / 作った とき)';
COMMENT ON COLUMN public.survey_record_sets.ended_at IS 'その セット に 最後 に 記録 が 入った 時刻';

-- 既存 セット は 記録 の 範囲 から 埋める
UPDATE public.survey_record_sets s
   SET started_at = COALESCE(s.started_at, r.first_at),
       ended_at   = COALESCE(s.ended_at, r.last_at)
  FROM (
        SELECT record_set_id, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at
          FROM public.staking_records
         WHERE record_set_id IS NOT NULL
         GROUP BY record_set_id
       ) r
 WHERE r.record_set_id = s.id;

NOTIFY pgrst, 'reload schema';
