-- 座標管理の経路（順路）テーブル
-- 地図上で順にクリックして選択した点を保存する。各点に up/down の方向を持つ。
CREATE TABLE IF NOT EXISTS design_coordinate_routes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  coordinate_id UUID NOT NULL REFERENCES design_coordinates(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  direction TEXT NOT NULL DEFAULT 'down' CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_coord_routes_farm_order
  ON design_coordinate_routes(farm_id, sort_order);

-- 更新日時の自動更新トリガー
DROP TRIGGER IF EXISTS update_design_coordinate_routes_updated_at ON design_coordinate_routes;
CREATE TRIGGER update_design_coordinate_routes_updated_at
  BEFORE UPDATE ON design_coordinate_routes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS: 圃場経由でアクセス可能なユーザーのみ
ALTER TABLE design_coordinate_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can access coordinate routes via farm"
  ON design_coordinate_routes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM farms
      WHERE farms.id = design_coordinate_routes.farm_id
      AND farms.user_id = auth.uid()
    )
  );
