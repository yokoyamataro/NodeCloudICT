-- design_survey_calibration に 平面 X / Y 方向 の 補正量 を 追加。
-- 従来 は dz_offset (Z 方向 の みず補正) だけ 保存 して いた が、GPS の
-- 系統差 や 基準点 の ずれ で 水平方向 に も 全体的 な オフセット が
-- 出る 事例 が あった ため、dx_offset / dy_offset を 追加 する。
--
-- 実測値 に 加算 して 補正後 X/Y/Z を 表示 / 出力 する。 デフォルト 0
-- (従来動作)。
ALTER TABLE design_survey_calibration
  ADD COLUMN IF NOT EXISTS dx_offset DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE design_survey_calibration
  ADD COLUMN IF NOT EXISTS dy_offset DOUBLE PRECISION NOT NULL DEFAULT 0;
