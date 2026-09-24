-- 農地整備 > 整地 でも 路線線形 の 仕組み で 現況 / 計画 / 出来形 を 管理 する。
--
-- 整地 の 路線 は 線形物 と データ の 形 が 同じ (線形点 / 測点 / 縦断 / 横断)
-- な ので 同じ テーブル に 入れ、 kind で 使い分ける。
--   kind = 'channel' : 線形物 (水路 / 道路)。 従来 どおり
--   kind = 'grading' : 整地。 線形 は BP と EP の 直線 だけ、 横断 は 20m 標準
--
-- 整地 で は 中心線 と 平行 に 縦断 を 並べて 格子 を 作る。 その 間隔 と 本数、
-- 線 の 名前 を grid_lines に 持つ。
--   { spacing: 20, leftCount: 3, rightCount: 3, centerName: 'F', names: { '-1': 'E' } }
--   - spacing    : 平行 縦断 の 間隔 [m] (= 中間点 の ピッチ)
--   - leftCount  : 中心 の 左 に 何本
--   - rightCount : 中心 の 右 に 何本
--   - centerName : 中心線 の 名前。 左右 は ここ から アルファベット で 自動
--                  (F なら 左 E,D,C,B,A,-A,-B / 右 G,H,I)
--   - names      : 自動 の 名前 を 個別 に 上書き (キー は 中心 から の 本数、 左 が 負)
--
-- 平行 縦断 の 高さ は 各 測点 の 横断 の 点列 (離れ = 本数 × 間隔) を 縦 に
-- 読んだ もの な ので、 専用 の カラム は 要ら ない。

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'channel',
  ADD COLUMN IF NOT EXISTS grid_lines JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_open_channels_farm_kind ON open_channels (farm_id, kind);
