-- 地図上の手書きペイント (ストローク) を工区単位で保存する。
--
-- 用途:
--   ・スマホ (MobileStakingPage) の描画タブ、PC (全体図) の描画モードで、
--     ペン (色 / 太さ) と消しゴムで自由に線を書く
--   ・地図を pan/zoom しても位置が変わらないよう lat/lng で保存
--
-- テーブル: map_drawings
--   ・1 ストローク = 1 行 (追加/削除が単純)
--   ・points は jsonb 配列 [{ "lat": 43.12345, "lng": 141.6789 }, ...]
--   ・color は '#rrggbb'、width_px は 1〜32 想定

CREATE TABLE IF NOT EXISTS public.map_drawings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  color TEXT NOT NULL DEFAULT '#ef4444',
  width_px NUMERIC NOT NULL DEFAULT 3,
  points JSONB NOT NULL,  -- [{lat, lng}, ...]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_map_drawings_farm_id
  ON public.map_drawings(farm_id);

DROP TRIGGER IF EXISTS update_map_drawings_updated_at ON public.map_drawings;
CREATE TRIGGER update_map_drawings_updated_at
  BEFORE UPDATE ON public.map_drawings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS: farm 単位のメンバー / 権限に従う
ALTER TABLE public.map_drawings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "map_drawings_select" ON public.map_drawings;
DROP POLICY IF EXISTS "map_drawings_insert" ON public.map_drawings;
DROP POLICY IF EXISTS "map_drawings_update" ON public.map_drawings;
DROP POLICY IF EXISTS "map_drawings_delete" ON public.map_drawings;

CREATE POLICY "map_drawings_select" ON public.map_drawings
  FOR SELECT USING (public.is_farm_viewer(farm_id));

CREATE POLICY "map_drawings_insert" ON public.map_drawings
  FOR INSERT WITH CHECK (public.is_farm_editor(farm_id));

CREATE POLICY "map_drawings_update" ON public.map_drawings
  FOR UPDATE USING (public.is_farm_editor(farm_id));

CREATE POLICY "map_drawings_delete" ON public.map_drawings
  FOR DELETE USING (public.is_farm_editor(farm_id));
