-- 文字に角度を持たせる。
--
-- 水平文字 (rotation_deg = 0) と 線上文字 (線の方位に合わせて回す) を
-- 同じ 1 つの値で扱う。反時計回りが正で、DXF の TEXT (グループコード 50) と同じ向き。
-- NULL / 未設定は 0 (水平) 扱い。

ALTER TABLE public.map_drawings
  ADD COLUMN IF NOT EXISTS rotation_deg real NOT NULL DEFAULT 0;
