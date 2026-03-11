-- NodeCloud-Design テーブル作成
-- Supabase SQL Editorで実行してください

-- ============================================
-- 1. プロジェクトテーブル
-- ============================================
CREATE TABLE IF NOT EXISTS design_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  coordinate_zone INTEGER NOT NULL DEFAULT 6, -- 平面直角座標系（1-19）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS有効化
ALTER TABLE design_projects ENABLE ROW LEVEL SECURITY;

-- ポリシー: 自分のプロジェクトのみアクセス可能
CREATE POLICY "Users can view own projects"
  ON design_projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
  ON design_projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON design_projects FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON design_projects FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 2. 座標テーブル
-- ============================================
CREATE TABLE IF NOT EXISTS design_coordinates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  point_number TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL, -- 平面直角座標X（北方向）
  y DOUBLE PRECISION NOT NULL, -- 平面直角座標Y（東方向）
  z DOUBLE PRECISION, -- 標高（任意）
  latitude DOUBLE PRECISION, -- 緯度（計算値）
  longitude DOUBLE PRECISION, -- 経度（計算値）
  coordinate_type TEXT NOT NULL DEFAULT 'other', -- control, boundary, temporary, other
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_design_coordinates_project ON design_coordinates(project_id);

-- RLS有効化
ALTER TABLE design_coordinates ENABLE ROW LEVEL SECURITY;

-- ポリシー: プロジェクト所有者のみアクセス
CREATE POLICY "Users can access coordinates via project"
  ON design_coordinates FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = design_coordinates.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 3. 区域テーブル
-- ============================================
CREATE TABLE IF NOT EXISTS design_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  zone_number TEXT NOT NULL,
  name TEXT NOT NULL,
  point_ids UUID[] NOT NULL DEFAULT '{}', -- 構成点IDリスト（順序付き）
  area_sqm DOUBLE PRECISION, -- 面積(m²)
  area_ha DOUBLE PRECISION, -- 面積(ha)
  perimeter_m DOUBLE PRECISION, -- 周長(m)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_design_zones_project ON design_zones(project_id);

-- RLS有効化
ALTER TABLE design_zones ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access zones via project"
  ON design_zones FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = design_zones.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 4. 管路テーブル（暗渠配管）
-- ============================================
CREATE TABLE IF NOT EXISTS design_pipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  number TEXT NOT NULL, -- 管路番号
  layer_name TEXT, -- CADレイヤ名
  pipe_type TEXT, -- main, branch, outlet, connection, spring, auxiliary, self_funded
  diameter INTEGER, -- 管径(mm)
  design_length DOUBLE PRECISION, -- 設計延長(m)
  measured_length DOUBLE PRECISION, -- 実測延長(m)
  vertices JSONB NOT NULL DEFAULT '[]', -- 構成点 [{x, y, z}, ...]
  connection_to UUID, -- 接続先管路ID
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_design_pipes_project ON design_pipes(project_id);

-- RLS有効化
ALTER TABLE design_pipes ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access pipes via project"
  ON design_pipes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = design_pipes.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 5. 更新日時自動更新トリガー
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_design_projects_updated_at
  BEFORE UPDATE ON design_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_design_coordinates_updated_at
  BEFORE UPDATE ON design_coordinates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_design_zones_updated_at
  BEFORE UPDATE ON design_zones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_design_pipes_updated_at
  BEFORE UPDATE ON design_pipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
