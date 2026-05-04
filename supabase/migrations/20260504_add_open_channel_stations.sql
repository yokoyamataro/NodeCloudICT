-- 線形物の中間点（測点）リスト
-- 配列要素: { id, label, distance, crossSection: StandardCrossSection | null }
--   distance: BP からの追加距離 (m)
--   label:    SP12.50 / BC34.20 / EC50.10 / IP25.00 など
--   crossSection: 個別設定の断面。null/未指定で標準断面（standard_cross_section）を使用。

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS stations JSONB NOT NULL DEFAULT '[]'::jsonb;
