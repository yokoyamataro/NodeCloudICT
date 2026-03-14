-- 施工計画テーブル作成
-- Supabase SQL Editorで実行してください

-- ============================================
-- 1. 施工計画テーブル（吸水行ごとのデータ）
-- ============================================
CREATE TABLE IF NOT EXISTS construction_plan_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  wiring_row_id TEXT NOT NULL, -- pipe_wiring_rowsのIDまたは仮ID
  group_type TEXT NOT NULL, -- 'collector' or 'direct'
  group_index INTEGER NOT NULL DEFAULT 0, -- 集水暗渠のタブインデックス
  row_index INTEGER NOT NULL DEFAULT 0, -- 行の順番
  -- 吸水管情報
  absorption_pipe_id UUID REFERENCES design_pipes(id) ON DELETE SET NULL,
  -- 集水/落口管情報
  collector_pipe_id UUID REFERENCES design_pipes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_construction_plan_rows_project ON construction_plan_rows(project_id);
CREATE INDEX idx_construction_plan_rows_order ON construction_plan_rows(project_id, group_type, group_index, row_index);

-- RLS有効化
ALTER TABLE construction_plan_rows ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access construction_plan_rows via project"
  ON construction_plan_rows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = construction_plan_rows.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 2. 施工計画点テーブル（各測点のデータ）
-- ============================================
CREATE TABLE IF NOT EXISTS construction_plan_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id UUID NOT NULL REFERENCES construction_plan_rows(id) ON DELETE CASCADE,
  point_type TEXT NOT NULL, -- 'absorption' (吸水測点) or 'collector' (集水合流点)
  point_index INTEGER NOT NULL DEFAULT 0, -- 点の順番（上流から）
  point_name TEXT NOT NULL, -- 点名
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  ground_height DOUBLE PRECISION, -- 地盤高
  planned_height DOUBLE PRECISION, -- 計画高（ユーザー入力）
  cut_depth DOUBLE PRECISION, -- 切深（自動計算: 地盤高 - 計画高）
  segment_distance DOUBLE PRECISION, -- 区間距離（前点との距離、自動計算）
  segment_slope TEXT, -- 区間勾配（1/xxx形式、自動計算）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_construction_plan_points_row ON construction_plan_points(row_id);
CREATE INDEX idx_construction_plan_points_order ON construction_plan_points(row_id, point_type, point_index);

-- RLS有効化
ALTER TABLE construction_plan_points ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access construction_plan_points via row"
  ON construction_plan_points FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM construction_plan_rows
      JOIN design_projects ON design_projects.id = construction_plan_rows.project_id
      WHERE construction_plan_rows.id = construction_plan_points.row_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 3. 更新日時自動更新トリガー
-- ============================================
CREATE TRIGGER update_construction_plan_rows_updated_at
  BEFORE UPDATE ON construction_plan_rows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_construction_plan_points_updated_at
  BEFORE UPDATE ON construction_plan_points
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
