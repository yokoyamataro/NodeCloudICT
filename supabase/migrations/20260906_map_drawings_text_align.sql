-- 文字を 基準点の 左右どちら側に 置くか。
--
--   'left'   … 基準点の 左側に 収まる (右端が 基準点)
--   'center' … 基準点を 中心に 置く (既定)
--   'right'  … 基準点の 右側に 伸びる (左端が 基準点)
--
-- 「左右」は 文字の向きから見た 左右。線上文字や 寸法値を 中央から ずらして
-- 置きたいときに使う。text_anchor (上下) と 組み合わせる。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS text_align text NOT NULL DEFAULT 'center';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_text_align_check') THEN
    ALTER TABLE public.map_drawings DROP CONSTRAINT map_drawings_text_align_check;
  END IF;
END $$;

ALTER TABLE public.map_drawings
  ADD CONSTRAINT map_drawings_text_align_check
  CHECK (text_align IN ('left', 'center', 'right'));
