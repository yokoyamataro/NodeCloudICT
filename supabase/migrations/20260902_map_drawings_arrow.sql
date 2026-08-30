-- 線の端部を 矢印にできるようにする。
--
--   'none'  … 矢印なし (既定)
--   'start' … 始点側だけ
--   'end'   … 終点側だけ
--   'both'  … 両端
--
-- 対象は 連続線 (kind='stroke')。面や円では 使わない。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS arrow text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_arrow_check') THEN
    ALTER TABLE public.map_drawings DROP CONSTRAINT map_drawings_arrow_check;
  END IF;
END $$;

ALTER TABLE public.map_drawings
  ADD CONSTRAINT map_drawings_arrow_check
  CHECK (arrow IN ('none', 'start', 'end', 'both'));
