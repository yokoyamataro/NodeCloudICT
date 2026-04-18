-- farms テーブルから coordinate_zone カラムを削除
-- 座標系はプロジェクト単位で管理するため、圃場ごとの設定は不要
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'farms' AND column_name = 'coordinate_zone'
  ) THEN
    ALTER TABLE farms DROP COLUMN coordinate_zone;
  END IF;
END $$;
