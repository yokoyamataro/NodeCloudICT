-- map_drawings に「円 / 円弧 / 面」種別を追加する。
--
-- 種別ごとの points 配置ルール (アプリ側で管理):
--   ・'stroke'  ペイントストローク: 頂点列 (n 点)
--   ・'text'    テキスト注釈: [ラベル位置] の 1 点
--   ・'circle'  円: [中心, 縁の点] の 2 点。半径 = 2 点間距離
--   ・'arc'     円弧: [始点, 通過点, 終点] の 3 点
--   ・'polygon' 面 (ポリゴン): 頂点列 (n 点、レンダ時に自動閉合)
--
-- 既存の 20260725e マイグレーションで作った CHECK 制約を差し替える。

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
  CHECK (kind IN ('stroke', 'text', 'circle', 'arc', 'polygon'));
