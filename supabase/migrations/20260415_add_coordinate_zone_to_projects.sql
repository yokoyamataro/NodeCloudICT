-- プロジェクトテーブルに座標系カラムを追加（存在しない場合）
-- 既存の coordinate_zone カラムがない場合のみ追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'coordinate_zone'
  ) THEN
    ALTER TABLE projects ADD COLUMN coordinate_zone INTEGER NOT NULL DEFAULT 13;
  END IF;
END $$;

-- 既存プロジェクトを13系に更新
UPDATE projects SET coordinate_zone = 13 WHERE coordinate_zone IS NULL OR coordinate_zone = 6;

-- デフォルト値を13系に変更
ALTER TABLE projects ALTER COLUMN coordinate_zone SET DEFAULT 13;
