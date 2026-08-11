-- construction_plan_points に区間ごとの管径カラムを追加
-- 施工計画表で、吸水管の区間 (絶縁点間) ごとに異なる管径を持てるようにする。
-- null の場合は design_pipes.diameter の値へフォールバックする運用。

ALTER TABLE construction_plan_points
  ADD COLUMN IF NOT EXISTS segment_diameter INTEGER;

COMMENT ON COLUMN construction_plan_points.segment_diameter IS
  '区間ごとの管径 (mm)。null の場合は所属パイプの design_pipes.diameter を使用する。';
