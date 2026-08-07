-- design_survey_calibration の farm_id UNIQUE 制約を確実に持たせる。
--
-- 初期スキーマは UNIQUE(project_id) だったが、その後 project_id → farm_id
-- へ列名変更した際、旧制約名 (design_survey_calibration_project_id_key)
-- のまま残っているケースがあるため、farm_id に対して UNIQUE を
-- 保証する制約を明示的に貼り直す。
--
-- クライアント側は upsert({...}, {onConflict:'farm_id'}) と書いており、
-- farm_id に UNIQUE がないと保存が「エラーにも成功にもならない」動きに
-- なって設定が丸ごと吹き飛ぶことが起きていた。

DO $$
DECLARE
  has_project_col boolean;
  has_farm_col boolean;
BEGIN
  -- 列の存在確認
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'design_survey_calibration'
      AND column_name = 'project_id'
  ) INTO has_project_col;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'design_survey_calibration'
      AND column_name = 'farm_id'
  ) INTO has_farm_col;

  -- 旧: project_id しかない環境 → 列名変更
  IF has_project_col AND NOT has_farm_col THEN
    EXECUTE 'ALTER TABLE public.design_survey_calibration RENAME COLUMN project_id TO farm_id';
  END IF;
END $$;

-- 既存の UNIQUE 制約を確認 (どの名前で残っていても壊さない)
DO $$
DECLARE
  has_farm_unique boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'design_survey_calibration'
      AND c.contype = 'u'
      AND a.attname = 'farm_id'
      AND array_length(c.conkey, 1) = 1
  ) INTO has_farm_unique;

  IF NOT has_farm_unique THEN
    EXECUTE 'ALTER TABLE public.design_survey_calibration
             ADD CONSTRAINT design_survey_calibration_farm_id_key UNIQUE (farm_id)';
  END IF;
END $$;
