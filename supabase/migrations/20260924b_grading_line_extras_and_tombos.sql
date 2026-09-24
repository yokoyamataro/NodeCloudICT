-- 整地グリッド の 縦線 (平行縦断) に 追加 する データ:
--   1. grading_line_extras — 各 縦線 (line_idx) 上 の 「中間点」。 グリッド 交点
--      (F,G,H… × 各 SP) の 間 に、独自 の SP と 標高 を 持つ 点 を 差し込める。
--      縦断図 に のみ 反映 し、グリッド 表 / 横断図 に は 出さ ない。
--   2. grading_line_tombos — 縦線 の 縦断図 上 の トンボ / 丁張。 横断 (station)
--      側 の tombos と は 別 の 器 (line_idx で 分類)。
--
-- どちら も client 側 で 一意 な id (kebab-case 等) を 発行 し、 JSONB 配列 で
-- 保持。 変化点 の 参照 は sp (BP からの 追加距離) で 記録 する ため、 グリッド
-- 交点 と 中間点 を 同 一 の 座標系 で 扱える。
--
-- 形:
--   grading_line_extras
--     [{ id, line_idx, sp, elevation, note? }]
--   grading_line_tombos
--     [{ id, line_idx, base_kind: 'grid' | 'extra' | 'free', base_sp, base_elev?,
--         dw, dh, name?, kind: 'tombo' | 'batter' }]

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS grading_line_extras JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS grading_line_tombos JSONB NOT NULL DEFAULT '[]'::jsonb;
