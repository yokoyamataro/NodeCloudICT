-- 中心線形（Alignment）テーブル
-- LandXML の <Alignment> 要素から取り込んだデータを圃場ごとに保持する。

CREATE TABLE IF NOT EXISTS design_alignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sta_start NUMERIC DEFAULT 0,
  total_length NUMERIC DEFAULT 0,
  source_file TEXT,
  -- セグメント（Line/Curve/Spiral）を JSONB で保持
  --   [{ type: 'line'|'curve'|'spiral',
  --      startX, startY, endX, endY, length,
  --      centerX?, centerY?, radius?, rotation?('cw'|'ccw'),
  --      spiralType?, startRadius?, endRadius? }, ...]
  segments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_design_alignments_farm_id ON design_alignments (farm_id);

-- RLS: 圃場の所有権に基づくポリシー
ALTER TABLE design_alignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "alignments_select_own_or_member"
  ON design_alignments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = design_alignments.farm_id
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

CREATE POLICY "alignments_insert_own_or_editor"
  ON design_alignments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = design_alignments.farm_id
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

CREATE POLICY "alignments_update_own_or_editor"
  ON design_alignments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = design_alignments.farm_id
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

CREATE POLICY "alignments_delete_own_or_editor"
  ON design_alignments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = design_alignments.farm_id
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

-- updated_at 自動更新
CREATE TRIGGER update_design_alignments_updated_at
  BEFORE UPDATE ON design_alignments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
