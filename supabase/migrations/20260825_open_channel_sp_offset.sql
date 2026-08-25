-- 河川・水路 の 線形物 に 先頭測点 (BP) の SP 値 オフセット を 追加。
-- 路線 の 途中 から IP を 入力する 場合 (BP を SP 224.69 に 設定 等) に、
-- 中間点計算 の ピッチ割 が 元路線 の 測点 (SP 400, 420, ...) と 合う ように する。
--
-- デフォルト 0 (従来動作)。
ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS sp_offset NUMERIC NOT NULL DEFAULT 0;
