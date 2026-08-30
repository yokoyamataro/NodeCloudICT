-- 線上文字を 線のどこに 置くか。
--
--   'center' … 線の真ん中 (線の上に 文字が 乗る。既定)
--   'above'  … 線の上側
--   'below'  … 線の下側
--
-- 「上 / 下」は 線の向きから見た 左右なので、線を 逆向きに引くと 入れ替わる。
-- 対象は kind='text'。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS text_anchor text NOT NULL DEFAULT 'center';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_text_anchor_check') THEN
    ALTER TABLE public.map_drawings DROP CONSTRAINT map_drawings_text_anchor_check;
  END IF;
END $$;

ALTER TABLE public.map_drawings
  ADD CONSTRAINT map_drawings_text_anchor_check
  CHECK (text_anchor IN ('center', 'above', 'below'));
