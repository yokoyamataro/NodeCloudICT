-- 工程の進捗状態テーブル
-- 圃場 × 工種 ごとに 1 行。状態は 'not_started' | 'in_progress' | 'completed' の 3 段階。
-- 将来的に細分化（複数工程の段階など）する場合は status を拡張するか、
-- 別途 farm_work_progress テーブルを追加する想定。
CREATE TABLE IF NOT EXISTS farm_work_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  work_type VARCHAR(50) NOT NULL, -- underdrain, soil_import, simple_grading, grading, subsoil, stone_removal
  status VARCHAR(20) NOT NULL DEFAULT 'not_started', -- not_started | in_progress | completed
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  UNIQUE (farm_id, work_type)
);

CREATE INDEX IF NOT EXISTS idx_farm_work_status_farm_id ON farm_work_status(farm_id);
CREATE INDEX IF NOT EXISTS idx_farm_work_status_work_type ON farm_work_status(work_type);

-- updated_at 自動更新トリガー（既存関数を利用）
DROP TRIGGER IF EXISTS update_farm_work_status_updated_at ON farm_work_status;
CREATE TRIGGER update_farm_work_status_updated_at
  BEFORE UPDATE ON farm_work_status
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS（既存テーブルと同じ運用方針: 必要に応じて有効化）
-- ALTER TABLE farm_work_status ENABLE ROW LEVEL SECURITY;
