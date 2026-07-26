-- map_drawings に線種 (実線 / 破線 / 点線) を追加する。
-- 既存行は既定値 'solid' で埋める (CHECK は緩めに: solid/dashed/dotted の 3 値)。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS line_style TEXT NOT NULL DEFAULT 'solid';

-- 値のガード (無効値の INSERT を拒否)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_line_style_check'
  ) THEN
    ALTER TABLE public.map_drawings
      ADD CONSTRAINT map_drawings_line_style_check
      CHECK (line_style IN ('solid', 'dashed', 'dotted'));
  END IF;
END $$;
