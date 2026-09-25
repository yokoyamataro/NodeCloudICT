-- 整地 の 地図 背景 に 使う 平面図 CAD の 位置合わせ。
--
-- 図面 そのもの は 既存 の open-channel-dxf バケット (channel.dxf_cross_sections)
-- を 使い回す。 この 列 に は 「どの 図面 を、 どの 2 点 で 実 座標 に 合わせるか」
-- だけ を 持つ。
--
-- 形:
--   { "dxfId": "<dxf_cross_sections の id>",
--     "p1": { "dx": 0, "dy": 0, "x": 100000, "y": 50000 },
--     "p2": { "dx": 1000, "dy": 0, "x": 100000, "y": 50500 },
--     "visible": true, "opacity": 0.7, "hiddenLayers": ["文字"] }
--   dx / dy = 図面 の 座標、 x / y = 実 座標 (x = 北, y = 東)。
--   2 点 から 回転 + 一様 倍率 + 平行移動 を 決める。
ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS plan_cad JSONB;

-- PostgREST の スキーマ キャッシュ を 更新 (これ を しない と PGRST204 に なる)
NOTIFY pgrst, 'reload schema';
