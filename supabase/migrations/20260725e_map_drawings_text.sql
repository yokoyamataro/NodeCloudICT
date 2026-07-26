-- map_drawings に「テキスト注釈」種別を追加する。
--
-- 変更:
--   1. kind TEXT ('stroke' | 'text') を追加。既存行は 'stroke' 扱い。
--   2. text TEXT (nullable) を追加。kind='text' のときにラベル文字列を保持。
--
-- テキストは points[0] を配置位置として使う (単一点)。
-- font size は既存の width_px を流用 (width_px * 2 を font-size px に換算)。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'stroke',
  ADD COLUMN IF NOT EXISTS text TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'map_drawings_kind_check'
  ) THEN
    ALTER TABLE public.map_drawings
      ADD CONSTRAINT map_drawings_kind_check
      CHECK (kind IN ('stroke', 'text'));
  END IF;
END $$;
