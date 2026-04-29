-- 客土工事 帯置計画テーブル
-- 工事区域ごとに 1 件保持（帯線・パラメータを JSONB で）

CREATE TABLE IF NOT EXISTS soil_import_strip_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  work_area_id UUID NOT NULL REFERENCES design_work_areas(id) ON DELETE CASCADE,
  -- 入力パラメータ（厚さ B / ダンプ積載量 v / 帯断面 WA・WB・H 等）
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 帯線（[lat, lng] の配列を、線ごとに格納）
  --   [[[lat, lng], [lat, lng], ...], ...]
  strips JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (farm_id, work_area_id)
);

CREATE INDEX IF NOT EXISTS idx_strip_plans_farm_id ON soil_import_strip_plans (farm_id);
CREATE INDEX IF NOT EXISTS idx_strip_plans_work_area_id ON soil_import_strip_plans (work_area_id);

-- RLS: 圃場メンバーベース
ALTER TABLE soil_import_strip_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strip_plans_select_own_or_member"
  ON soil_import_strip_plans FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = soil_import_strip_plans.farm_id
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

CREATE POLICY "strip_plans_insert_own_or_editor"
  ON soil_import_strip_plans FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = soil_import_strip_plans.farm_id
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

CREATE POLICY "strip_plans_update_own_or_editor"
  ON soil_import_strip_plans FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = soil_import_strip_plans.farm_id
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

CREATE POLICY "strip_plans_delete_own_or_editor"
  ON soil_import_strip_plans FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM farms f
      WHERE f.id = soil_import_strip_plans.farm_id
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

CREATE TRIGGER update_strip_plans_updated_at
  BEFORE UPDATE ON soil_import_strip_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
