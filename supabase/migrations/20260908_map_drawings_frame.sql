-- 図枠を 独立した種別にする。
--
-- 用紙の大きさ + 縮尺から 置く 四角。面と 同じ 4 頂点だが、
--   ・塗らない (下の地図が 隠れない)
--   ・専用のレイヤ「図枠」に 入れて、既定では 一番下 (奥) に 置く
-- という 扱いなので、面とは 分けて 持つ。
--
-- points は [左下, 右下, 右上, 左上] の 4 点。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_kind_check'
  ) THEN
    ALTER TABLE public.map_drawings
      DROP CONSTRAINT map_drawings_kind_check;
  END IF;
END $$;

ALTER TABLE public.map_drawings
  ADD CONSTRAINT map_drawings_kind_check
  CHECK (kind IN ('stroke', 'text', 'circle', 'arc', 'polygon', 'point', 'frame'));
