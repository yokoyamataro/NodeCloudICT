-- 線形物（旧: 小水路）の標準断面を要素列ベースに刷新
-- 旧: floor_width / slope_ratio / bank_height（パラメトリック単純台形）
-- 新: standard_cross_section JSONB
--     { right: [{ id, name, width, slopeValue, slopeUnit }, ...],
--       left:  [{ id, name, width, slopeValue, slopeUnit }, ...] }
--   - width: m
--   - slopeValue: 数値（符号付き。+ で外側に向かって上り、- で下り）
--   - slopeUnit: 'ratio' | 'percent'
--   - name: ラベル（床/法面/道路部 等。空可。色分け等の将来拡張用）

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS standard_cross_section JSONB NOT NULL DEFAULT '{"right": [], "left": []}'::jsonb;

ALTER TABLE open_channels DROP COLUMN IF EXISTS floor_width;
ALTER TABLE open_channels DROP COLUMN IF EXISTS slope_ratio;
ALTER TABLE open_channels DROP COLUMN IF EXISTS bank_height;
