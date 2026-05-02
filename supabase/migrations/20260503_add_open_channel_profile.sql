-- 小水路に縦断線形（profile）を追加
-- 線形変化点ごとに { distance: 追加距離 (m), floorHeight: 床高 (m) } を保持。
-- BP からの累積距離で位置を表す。

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS profile_points JSONB NOT NULL DEFAULT '[]'::jsonb;
