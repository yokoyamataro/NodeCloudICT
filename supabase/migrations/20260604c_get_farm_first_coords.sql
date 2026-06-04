-- 工区ごとの「先頭座標 1 行」だけを返す RPC。
--
-- 経緯:
--   farmStore.fetchFarmLocations は工区マーカーの位置を出すため、各工区の
--   先頭座標 (design_coordinates) を引いていた。しかし
--   `supabase.from('design_coordinates').in('farm_id', [...])` を生で実行
--   すると Supabase の db-max-rows（既定 1000）に引っかかり、座標数が多い
--   プロジェクトでは後ろの工区が結果から脱落して地図に出ない問題があった。
--
--   ここで DISTINCT ON (farm_id) で工区ごとに 1 行だけ返す RPC を用意し、
--   フロントを RPC 呼び出しに置き換えることで、戻り行数を「工区数」に
--   抑える。
--
-- 並び順: 点番（point_number）の単純昇順。テキストソートだが、用途は
--   「マーカーの代表座標」なのでどの 1 行でも問題ない。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

CREATE OR REPLACE FUNCTION public.get_farm_first_coords(p_farm_ids uuid[])
RETURNS TABLE (
  farm_id uuid,
  point_number text,
  x numeric,
  y numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ON (c.farm_id)
    c.farm_id,
    c.point_number,
    c.x,
    c.y
  FROM public.design_coordinates c
  WHERE c.farm_id = ANY (p_farm_ids)
  ORDER BY c.farm_id, c.point_number;
$$;

GRANT EXECUTE ON FUNCTION public.get_farm_first_coords(uuid[]) TO authenticated;
