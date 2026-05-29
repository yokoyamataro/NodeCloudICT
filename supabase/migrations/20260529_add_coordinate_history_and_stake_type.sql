-- 座標管理: 作成者 / 更新者 / 杭種 を追加し、更新時に updated_at と updated_by を自動更新する。
-- Supabase SQL Editor で実行する。

ALTER TABLE design_coordinates
  ADD COLUMN IF NOT EXISTS stake_type TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_design_coordinates_updated_by
  ON design_coordinates(updated_by);
CREATE INDEX IF NOT EXISTS idx_design_coordinates_created_by
  ON design_coordinates(created_by);

-- INSERT 時に created_by / updated_by を auth.uid() で自動設定
CREATE OR REPLACE FUNCTION set_design_coordinate_audit_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  IF NEW.updated_by IS NULL THEN NEW.updated_by := auth.uid(); END IF;
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_design_coordinates_audit_insert ON design_coordinates;
CREATE TRIGGER trg_design_coordinates_audit_insert
  BEFORE INSERT ON design_coordinates
  FOR EACH ROW
  EXECUTE FUNCTION set_design_coordinate_audit_insert();

-- UPDATE 時に updated_by / updated_at を auth.uid() / now() で自動更新
CREATE OR REPLACE FUNCTION set_design_coordinate_audit_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  NEW.updated_at := now();
  -- created_by / created_at は保持
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_design_coordinates_audit_update ON design_coordinates;
CREATE TRIGGER trg_design_coordinates_audit_update
  BEFORE UPDATE ON design_coordinates
  FOR EACH ROW
  EXECUTE FUNCTION set_design_coordinate_audit_update();
