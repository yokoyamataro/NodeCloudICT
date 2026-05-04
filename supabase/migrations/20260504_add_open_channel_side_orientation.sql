-- 線形物の左右基準方向（断面の右/左をどちらから見て決めるか）
-- 'forward': 起点 → 終点 を見る方向（道路工事の慣習）
-- 'reverse': 終点 → 起点 を見る方向（河川工事の慣習）

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS side_orientation TEXT NOT NULL DEFAULT 'forward';

ALTER TABLE open_channels DROP CONSTRAINT IF EXISTS open_channels_side_orientation_check;
ALTER TABLE open_channels
  ADD CONSTRAINT open_channels_side_orientation_check
  CHECK (side_orientation IN ('forward', 'reverse'));
