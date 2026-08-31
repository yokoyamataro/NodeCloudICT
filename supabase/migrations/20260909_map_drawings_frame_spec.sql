-- 図枠の 素性 (用紙 / 縮尺 / 内枠 / 原点 / 向き) を 残す 列。
--
-- points は 地図に 焼いた 座標 (外枠 4 点、内枠つきは 続けて 内枠 4 点) なので、
-- そこからは 「A3 を 1/1000 で 置いた」ことが 分からない。あとから 縮尺で
-- 出したり 用紙で 絞ったり できるよう、置いたときの 値を そのまま 持つ。
--
-- frame = {
--   "paper": "A3",                -- 'A4'〜'A0' / 'free'
--   "landscape": true,
--   "widthMm": 420, "heightMm": 297,   -- 向きを 当てはめた あとの 用紙 [mm]
--   "scale": 1000,                -- 縮尺の 分母 (1/1000)
--   "inset": { "left": 10, "right": 10, "top": 10, "bottom": 10 },  -- 内枠 [用紙 mm]。内枠なしは null
--   "origin": { "lat": ..., "lng": ... },  -- 外枠の 左下
--   "angleDeg": 0                 -- 幅の向き。東を 0 とした 反時計回り
-- }
--
-- kind='frame' 以外は NULL。図枠は 置いたあと 形を 変えられず、移動と 回転の
-- ときだけ origin / angleDeg を 点列と 一緒に 更新する。
-- 既存の 図枠は frame が NULL のまま (点列だけで 今までどおり 動く)。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS frame jsonb;
