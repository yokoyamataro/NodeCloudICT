-- 測量データテーブル作成
-- Supabase SQL Editorで実行してください

-- ============================================
-- 測量データテーブル（SIMインポートしたデータを保存）
-- ============================================
CREATE TABLE IF NOT EXISTS design_survey_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  point_number TEXT NOT NULL, -- 測量点番号
  x DOUBLE PRECISION NOT NULL, -- 測量X座標
  y DOUBLE PRECISION NOT NULL, -- 測量Y座標
  z DOUBLE PRECISION, -- 測量標高
  matched_point_id TEXT, -- マッチした設計点のID（管路頂点ID or 座標ID）
  matched_point_type TEXT, -- マッチ元の種類（pipe / coordinate）
  match_distance DOUBLE PRECISION, -- マッチ距離(m)
  category TEXT NOT NULL DEFAULT 'other', -- カテゴリ（control, boundary, underdrain, other）
  dz_raw DOUBLE PRECISION, -- 生の標高差（測量Z - 設計Z）
  dz_calibrated DOUBLE PRECISION, -- 補正後の標高差
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_design_survey_data_project ON design_survey_data(project_id);
CREATE INDEX idx_design_survey_data_matched ON design_survey_data(matched_point_id);

-- RLS有効化
ALTER TABLE design_survey_data ENABLE ROW LEVEL SECURITY;

-- ポリシー: プロジェクト所有者のみアクセス
CREATE POLICY "Users can access survey_data via project"
  ON design_survey_data FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = design_survey_data.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- 更新日時自動更新トリガー
CREATE TRIGGER update_design_survey_data_updated_at
  BEFORE UPDATE ON design_survey_data
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 測量データ補正設定テーブル
-- ============================================
CREATE TABLE IF NOT EXISTS design_survey_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  dz_offset DOUBLE PRECISION NOT NULL DEFAULT 0, -- 補正量
  matching_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.2, -- マッチング閾値(m)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id) -- プロジェクトごとに1レコード
);

-- RLS有効化
ALTER TABLE design_survey_calibration ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access survey_calibration via project"
  ON design_survey_calibration FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = design_survey_calibration.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- 更新日時自動更新トリガー
CREATE TRIGGER update_design_survey_calibration_updated_at
  BEFORE UPDATE ON design_survey_calibration
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
