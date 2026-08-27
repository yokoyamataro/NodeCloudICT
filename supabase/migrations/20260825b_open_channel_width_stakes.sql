-- 河川・水路 の 線形物 に 幅杭 (width_stakes) を 追加。
-- 追加距離 と 中心線 から の 垂直方向 オフセット (左 マイナス) を 指定して
-- 平面座標 X/Y を 計算する 補助的 な 測点。
--
-- 構造:
--   [
--     { "id": "ws-...", "distance": 175.31, "offset": 2.5, "note": "任意" },
--     ...
--   ]
--
-- distance は BP から の 内部 累積距離 (m)。 offset は 中心線 に 対して
-- 進行方向 右手 が +、左手 が -。 sideOrientation='reverse' (河川モード)
-- の 場合 は アプリ側 で 符号 を 反転する。
ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS width_stakes JSONB NOT NULL DEFAULT '[]'::jsonb;
