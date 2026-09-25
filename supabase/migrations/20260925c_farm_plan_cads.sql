-- 工区 の 背景 に 敷く 平面図 CAD (複数 枚)。
--
-- 図面 そのもの は ファイル管理 (farm_files) に 上げた もの を 使い回す。
-- ここ に は 「どの ファイル を、 どの 2 点 で 実 座標 に 合わせるか」 を 持つ。
-- 工区 単位 な ので 全 工種 と スマホ で 共通 に 使える。
--
-- 形:
--   [{ "id": "pc-...", "name": "平面図",
--      "storagePath": "<farm_files の storage_path>",
--      "p1": { "dx": 0, "dy": 0, "x": 100000, "y": 50000 },
--      "p2": { "dx": 1000, "dy": 0, "x": 100000, "y": 50500 },
--      "visible": true, "opacity": 0.7 }]
--   dx / dy = 図面 の 座標、 x / y = 実 座標 (x = 北, y = 東)。
ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS plan_cads JSONB NOT NULL DEFAULT '[]'::jsonb;

-- PostgREST の スキーマ キャッシュ を 更新 (これ を しない と PGRST204 に なる)
NOTIFY pgrst, 'reload schema';
