-- 地番 の 構成点 を 「仮」 と 「確定」 の 2 本 持つ。
--
-- 先の 20260910 では 仮 / 確定 を design_work_areas の 別行 (boundary_kind) に
-- して いたが、それだと
--   * 同じ 地番 が 2 行 に 割れる (地番名 の 文字列一致 で しか 対応づけ できない)
--   * 地番属性 (parcels) も 2 行 に 割れて 二重管理 に なる
--   * 工区あたりの 地番数 を 2 筆 として 消費 する
-- という 筋の悪さ が あった。
--
-- 地番 は 1 行 の まま に して、構成点 の 配列 を もう 1 本 足す:
--   point_ids           … 仮境界 の 構成点 (従来 どおり。既存データ は すべて こちら)
--   confirmed_point_ids … 確定境界 の 構成点 (立会・確定測量 の 成果)
-- 画面 は どちら を 出す かを 切り替える だけ。

ALTER TABLE public.design_work_areas
  ADD COLUMN IF NOT EXISTS confirmed_point_ids UUID[] NOT NULL DEFAULT '{}';

-- 面積 / 周長 も 形 ごと に 変わる ので 確定用 を 別に 持つ
ALTER TABLE public.design_work_areas
  ADD COLUMN IF NOT EXISTS confirmed_area_sqm DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS confirmed_area_ha DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS confirmed_perimeter_m DOUBLE PRECISION;

COMMENT ON COLUMN public.design_work_areas.point_ids IS
  '仮境界 (当初) の 構成点。 design_coordinates.id の 順序つき 配列';
COMMENT ON COLUMN public.design_work_areas.confirmed_point_ids IS
  '確定境界 の 構成点。 立会・確定測量 の 成果。 空 なら 未登録';

-- boundary_kind (20260910) は 使わなく なった。 既に 確定 として 取り込んだ 行が
-- あれば、その 構成点 を confirmed_point_ids 側 に 移して おく。
-- (行 は 残す。 誤って 消さない ため。 不要 なら 手で 消す)
UPDATE public.design_work_areas
SET confirmed_point_ids = point_ids,
    confirmed_area_sqm = area_sqm,
    confirmed_area_ha = area_ha,
    confirmed_perimeter_m = perimeter_m
WHERE boundary_kind = 'confirmed'
  AND confirmed_point_ids = '{}'
  AND point_ids IS NOT NULL;
