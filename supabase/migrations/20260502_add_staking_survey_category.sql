-- 工事測量の区分（起工 / 出来形）を staking_records に追加
-- スマホの起工測量と出来形測量を一元化したため、レコードの区分けに使う。
--   'initial' = 起工測量
--   'asbuilt' = 出来形測量

ALTER TABLE staking_records
  ADD COLUMN IF NOT EXISTS survey_category TEXT NOT NULL DEFAULT 'initial'
  CHECK (survey_category IN ('initial', 'asbuilt'));

CREATE INDEX IF NOT EXISTS idx_staking_records_survey_category
  ON staking_records (survey_category);
