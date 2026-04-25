-- 起工測量（Staking）の実測記録テーブル
-- 測設ターゲット（座標管理または暗渠頂点）と、現地 RTK-GNSS で記録した
-- 実測値・精度・サンプル数を保持する。

CREATE TABLE IF NOT EXISTS staking_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  -- ターゲット情報
  -- target_type: 'coordinate'（座標管理）/ 'pipe_vertex'（暗渠頂点）/ 'free'（フリー）
  target_type TEXT NOT NULL CHECK (target_type IN ('coordinate', 'pipe_vertex', 'free')),
  target_ref_id UUID, -- coordinate id または pipe id（pipe_vertex の場合）
  target_vertex_index INTEGER, -- pipe_vertex の場合の頂点 index
  target_name TEXT, -- 表示用: P1, K13C 等
  target_x NUMERIC, -- 目標 X（北方向）
  target_y NUMERIC, -- 目標 Y（東方向）
  target_z NUMERIC, -- 目標 Z（標高）
  -- 実測値
  measured_x NUMERIC NOT NULL,
  measured_y NUMERIC NOT NULL,
  measured_z NUMERIC,
  -- 測定精度・品質
  accuracy NUMERIC, -- 最終精度（m, 最大または平均）
  sample_count INTEGER, -- 平均に使ったサンプル数
  duration_seconds NUMERIC, -- 記録にかかった秒数
  -- メタ
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staking_records_farm_id ON staking_records (farm_id);
CREATE INDEX IF NOT EXISTS idx_staking_records_recorded_at ON staking_records (recorded_at DESC);

-- RLS
ALTER TABLE staking_records ENABLE ROW LEVEL SECURITY;

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

CREATE TRIGGER update_staking_records_updated_at
  BEFORE UPDATE ON staking_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
