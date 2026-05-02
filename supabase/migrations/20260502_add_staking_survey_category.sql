-- 工事測量の区分（起工 / 出来形）を staking_records に追加
-- スマホの起工測量と出来形測量を一元化したため、レコードの区分けに使う。
--   'initial' = 起工測量
--   'asbuilt' = 出来形測量
--
-- 注: 旧マイグレーション 20260422_add_staking_records.sql が未適用の環境でも
-- そのまま実行できるよう、テーブル本体の作成も含めた一体型マイグレーション。
--   - テーブル未作成: ここで一気に作成（survey_category も最初から含む）
--   - 既作成: 列のみ追加 / 既に列があれば NO-OP

-- ============================================================
-- 1. テーブル作成（既存なら NO-OP）
-- ============================================================
CREATE TABLE IF NOT EXISTS staking_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  -- ターゲット情報
  target_type TEXT NOT NULL CHECK (target_type IN ('coordinate', 'pipe_vertex', 'free')),
  target_ref_id UUID,
  target_vertex_index INTEGER,
  target_name TEXT,
  target_x NUMERIC,
  target_y NUMERIC,
  target_z NUMERIC,
  -- 実測値
  measured_x NUMERIC NOT NULL,
  measured_y NUMERIC NOT NULL,
  measured_z NUMERIC,
  -- 測定精度・品質
  accuracy NUMERIC,
  sample_count INTEGER,
  duration_seconds NUMERIC,
  -- メタ
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID REFERENCES auth.users(id),
  notes TEXT,
  -- 工事測量の区分
  survey_category TEXT NOT NULL DEFAULT 'initial'
    CHECK (survey_category IN ('initial', 'asbuilt')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. 列追加（既存テーブルへ後付け、無ければ作る）
-- ============================================================
ALTER TABLE staking_records
  ADD COLUMN IF NOT EXISTS survey_category TEXT NOT NULL DEFAULT 'initial';

-- CHECK 制約は IF NOT EXISTS が無いので、重複を避けて条件付き追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staking_records_survey_category_check'
  ) THEN
    ALTER TABLE staking_records
      ADD CONSTRAINT staking_records_survey_category_check
      CHECK (survey_category IN ('initial', 'asbuilt'));
  END IF;
END $$;

-- ============================================================
-- 3. インデックス
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_staking_records_farm_id ON staking_records (farm_id);
CREATE INDEX IF NOT EXISTS idx_staking_records_recorded_at ON staking_records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_staking_records_survey_category ON staking_records (survey_category);

-- ============================================================
-- 4. RLS（既存ポリシーがあれば置き換え）
-- ============================================================
ALTER TABLE staking_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staking_records_select_own_or_member" ON staking_records;
CREATE POLICY "staking_records_select_own_or_member"
  ON staking_records FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = staking_records.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
          )
        )
    )
  );

DROP POLICY IF EXISTS "staking_records_insert_own_or_editor" ON staking_records;
CREATE POLICY "staking_records_insert_own_or_editor"
  ON staking_records FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = staking_records.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

DROP POLICY IF EXISTS "staking_records_update_own_or_editor" ON staking_records;
CREATE POLICY "staking_records_update_own_or_editor"
  ON staking_records FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = staking_records.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

DROP POLICY IF EXISTS "staking_records_delete_own_or_editor" ON staking_records;
CREATE POLICY "staking_records_delete_own_or_editor"
  ON staking_records FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = staking_records.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

-- ============================================================
-- 5. updated_at 自動更新トリガー（既存なら作り直し）
-- ============================================================
DROP TRIGGER IF EXISTS update_staking_records_updated_at ON staking_records;
CREATE TRIGGER update_staking_records_updated_at
  BEFORE UPDATE ON staking_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
