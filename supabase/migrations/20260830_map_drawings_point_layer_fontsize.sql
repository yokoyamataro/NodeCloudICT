-- 作図・計測ツールを ペイント (map_drawings) へ統合するための拡張。
--
-- 追加するもの:
--   ・kind に 'point' を追加   … 単独の点。座標管理への登録有無は アプリ側の
--                                チェックで決める (登録しても点自体は ここに残す)
--   ・layer                    … DXF 出力時の レイヤ名。未指定は '0' (CAD の既定レイヤ)
--   ・font_size                … テキストの 文字サイズ [px]。
--                                NULL の 既存データは 従来どおり width_px から換算する
--
-- points の配置ルール (アプリ側で管理):
--   ・'point'   [位置] の 1 点

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
  CHECK (kind IN ('stroke', 'text', 'circle', 'arc', 'polygon', 'point'));

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT '0';

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS font_size integer;

-- レイヤ名の候補を出すために使う (工区内の distinct layer)
CREATE INDEX IF NOT EXISTS idx_map_drawings_farm_layer
  ON public.map_drawings (farm_id, layer);
