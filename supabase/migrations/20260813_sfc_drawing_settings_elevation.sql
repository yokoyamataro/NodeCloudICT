-- ============================================================
-- 基準杭座標一覧表のフッタで使う 標高系 と ジオイド2024 との差分
-- (工区ごと)
-- ============================================================

ALTER TABLE public.sfc_drawing_settings
  ADD COLUMN IF NOT EXISTS elevation_system text NOT NULL DEFAULT '2024',
  ADD COLUMN IF NOT EXISTS elevation_delta double precision NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.sfc_drawing_settings.elevation_system IS
  'SFC 基準杭表フッタの標高系。 2024 (ジオイド2024) / 2011 (ジオイド2011) / custom (任意標高)';
COMMENT ON COLUMN public.sfc_drawing_settings.elevation_delta IS
  'ジオイド2024 との差分 (m)。 2024 のとき無視、それ以外は括弧書きで表示に使う';
