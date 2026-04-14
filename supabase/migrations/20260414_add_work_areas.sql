-- 工種別工事区域テーブル
CREATE TABLE IF NOT EXISTS design_work_areas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  work_type VARCHAR(50) NOT NULL, -- underdrain, soil_import, simple_grading, subsoil, stone_removal
  zone_number VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  point_ids UUID[] DEFAULT '{}', -- 構成点IDリスト（順序付き） - レガシー用、新方式では使用しない
  area_sqm NUMERIC(15, 4),
  area_ha NUMERIC(15, 8),
  perimeter_m NUMERIC(15, 4),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- 工事区域の座標点テーブル
CREATE TABLE IF NOT EXISTS work_area_coordinates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_area_id UUID NOT NULL REFERENCES design_work_areas(id) ON DELETE CASCADE,
  point_number VARCHAR(50) NOT NULL,
  x NUMERIC(15, 4) NOT NULL,
  y NUMERIC(15, 4) NOT NULL,
  z NUMERIC(10, 4),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_design_work_areas_farm_id ON design_work_areas(farm_id);
CREATE INDEX IF NOT EXISTS idx_design_work_areas_work_type ON design_work_areas(work_type);
CREATE INDEX IF NOT EXISTS idx_work_area_coordinates_work_area_id ON work_area_coordinates(work_area_id);
CREATE INDEX IF NOT EXISTS idx_work_area_coordinates_sort_order ON work_area_coordinates(sort_order);

-- updated_atを自動更新するトリガー
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = TIMEZONE('utc', NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_design_work_areas_updated_at ON design_work_areas;
CREATE TRIGGER update_design_work_areas_updated_at
  BEFORE UPDATE ON design_work_areas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_work_area_coordinates_updated_at ON work_area_coordinates;
CREATE TRIGGER update_work_area_coordinates_updated_at
  BEFORE UPDATE ON work_area_coordinates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLSポリシー（必要に応じてコメントを外す）
-- ALTER TABLE design_work_areas ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE work_area_coordinates ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY "Users can view their own farm work areas" ON design_work_areas
--   FOR SELECT USING (
--     farm_id IN (
--       SELECT id FROM farms WHERE user_id = auth.uid()
--     )
--   );

-- CREATE POLICY "Users can insert their own farm work areas" ON design_work_areas
--   FOR INSERT WITH CHECK (
--     farm_id IN (
--       SELECT id FROM farms WHERE user_id = auth.uid()
--     )
--   );

-- CREATE POLICY "Users can update their own farm work areas" ON design_work_areas
--   FOR UPDATE USING (
--     farm_id IN (
--       SELECT id FROM farms WHERE user_id = auth.uid()
--     )
--   );

-- CREATE POLICY "Users can delete their own farm work areas" ON design_work_areas
--   FOR DELETE USING (
--     farm_id IN (
--       SELECT id FROM farms WHERE user_id = auth.uid()
--     )
--   );
