-- 任意測点。 地図 を 押して 拾った だけ の 点。
--
-- 平面図 CAD の 位置合わせ の 基準 に 使う の が 主な 用途。
-- 座標管理 に は 載せ ない (測量 の 成果 で は ない ため)。
--
-- 形:
--   [{ "id": "fp-...", "name": "任意測点1", "x": 100000.0, "y": 50000.0 }]
--   x = 北、 y = 東。 高さ は 今 は 持た ない。
ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS free_points JSONB NOT NULL DEFAULT '[]'::jsonb;

-- PostgREST の スキーマ キャッシュ を 更新 (これ を しない と PGRST204 に なる)
NOTIFY pgrst, 'reload schema';
