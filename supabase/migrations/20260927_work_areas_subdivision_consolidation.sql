-- 地番 (design_work_areas) に 分筆筆界・合筆筆界 の 構成点列 を 追加。
--
-- 既存 の point_ids (仮筆界) / confirmed_point_ids (確定筆界) と 同じ 形で、
-- design_coordinates.id の 配列 を 順序 付き で 持つ。
-- どちら も 未設定 は 空配列 扱い。
--
-- 面積 / 周長 は フロント で 座標法 で 計算 する ので DB 側 に 持たない。

BEGIN;

ALTER TABLE public.design_work_areas
  ADD COLUMN IF NOT EXISTS subdivision_point_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS consolidation_point_ids TEXT[] NOT NULL DEFAULT '{}';

NOTIFY pgrst, 'reload schema';

COMMIT;
