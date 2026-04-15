-- design_work_areasにpoint_idsカラムを追加（存在しない場合）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'design_work_areas' AND column_name = 'point_ids'
  ) THEN
    ALTER TABLE design_work_areas ADD COLUMN point_ids UUID[] DEFAULT '{}';
  END IF;
END $$;

-- 既存のwork_area_coordinatesデータをpoint_idsに移行
UPDATE design_work_areas dwa
SET point_ids = (
  SELECT COALESCE(
    array_agg(dc.id ORDER BY wac.sort_order),
    '{}'::uuid[]
  )
  FROM work_area_coordinates wac
  JOIN design_coordinates dc ON dc.point_number = wac.point_number AND dc.farm_id = dwa.farm_id
  WHERE wac.work_area_id = dwa.id
)
WHERE EXISTS (
  SELECT 1 FROM work_area_coordinates WHERE work_area_id = dwa.id
);
