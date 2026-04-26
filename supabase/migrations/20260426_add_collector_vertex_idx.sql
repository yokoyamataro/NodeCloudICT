-- pipe_wiring_rows に collector_vertex_idx カラムを追加。
-- collector_change 行が指す集水管の頂点 index を明示的に保存する。
-- 一括設定で生成されたデータが保存→再読込で意味を保てるようにする。

ALTER TABLE public.pipe_wiring_rows
  ADD COLUMN IF NOT EXISTS collector_vertex_idx INTEGER;
