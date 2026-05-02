-- 小水路（明渠）の線形 + 断面テーブル
-- 区域は持たず、線形（BP→IP→EP）と断面（床幅 W / 斜面勾配 1:i）で定義

CREATE TABLE IF NOT EXISTS open_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  -- 表示用識別
  name TEXT NOT NULL,
  -- 断面パラメータ
  -- 床幅 W (m)：中心 ±W/2 が水平な床
  floor_width NUMERIC NOT NULL DEFAULT 0.5,
  -- 斜面勾配 1:i（i 値）。床端から外側 sw 進むと sw/i 高くなる
  slope_ratio NUMERIC NOT NULL DEFAULT 1.0,
  -- 設計法面深さ（任意）：法肩までの斜面高さ (m)
  bank_height NUMERIC,
  -- 線形の点列：[{ kind: 'bp'|'ip'|'ep', coordId: UUID, radius?: number, sortOrder: int }, ...]
  alignment_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_open_channels_farm_id ON open_channels (farm_id);

-- RLS: 圃場メンバーベース（既存パターン踏襲）
ALTER TABLE open_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_channels_select_own_or_member" ON open_channels;
CREATE POLICY "open_channels_select_own_or_member"
  ON open_channels FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = open_channels.farm_id
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

DROP POLICY IF EXISTS "open_channels_insert_own_or_editor" ON open_channels;
CREATE POLICY "open_channels_insert_own_or_editor"
  ON open_channels FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = open_channels.farm_id
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

DROP POLICY IF EXISTS "open_channels_update_own_or_editor" ON open_channels;
CREATE POLICY "open_channels_update_own_or_editor"
  ON open_channels FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = open_channels.farm_id
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

DROP POLICY IF EXISTS "open_channels_delete_own_or_editor" ON open_channels;
CREATE POLICY "open_channels_delete_own_or_editor"
  ON open_channels FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = open_channels.farm_id
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

CREATE TRIGGER update_open_channels_updated_at
  BEFORE UPDATE ON open_channels
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
