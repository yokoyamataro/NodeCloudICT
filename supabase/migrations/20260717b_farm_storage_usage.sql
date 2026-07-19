-- 工区 (farm) ごとのデータ容量を集計する RPC。
-- 対象:
--   attachments (写真、登記PDF、その他添付) — entity_type + entity_id で紐付く分
--   landxml_files
-- 除外:
--   オルソタイル (storage.objects の path prefix 検索が必要でコスト大。将来対応)

CREATE OR REPLACE FUNCTION public.get_farm_storage_usage(p_farm_id UUID)
RETURNS TABLE (
  photos_bytes BIGINT,
  photos_count BIGINT,
  registry_pdf_bytes BIGINT,
  registry_pdf_count BIGINT,
  other_attachment_bytes BIGINT,
  other_attachment_count BIGINT,
  landxml_bytes BIGINT,
  landxml_count BIGINT,
  total_bytes BIGINT,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 権限チェック: farm の viewer 権限
  IF NOT public.is_farm_viewer(p_farm_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH farm_entities AS (
    -- 工区本体 (工区写真等)
    SELECT 'farm'::text AS t, p_farm_id AS id
    UNION ALL
    -- 座標
    SELECT 'coordinate'::text, id FROM public.design_coordinates WHERE farm_id = p_farm_id
    UNION ALL
    -- 工事区域
    SELECT 'work_area'::text, id FROM public.design_work_areas WHERE farm_id = p_farm_id
  ),
  attach AS (
    SELECT
      a.category,
      a.byte_size
    FROM public.attachments a
    JOIN farm_entities fe ON a.entity_type = fe.t AND a.entity_id = fe.id
  ),
  photo_agg AS (
    SELECT
      COALESCE(SUM(byte_size), 0)::BIGINT AS b,
      COUNT(*)::BIGINT AS c
    FROM attach
    WHERE category IS NULL
       OR category NOT IN ('registry_pdf', 'registry_ownership', 'registry_full')
  ),
  registry_agg AS (
    SELECT
      COALESCE(SUM(byte_size), 0)::BIGINT AS b,
      COUNT(*)::BIGINT AS c
    FROM attach
    WHERE category IN ('registry_pdf', 'registry_ownership', 'registry_full')
  ),
  other_agg AS (
    -- 分類の "その他" 予約 (現状は写真とみなしているので 0)
    SELECT 0::BIGINT AS b, 0::BIGINT AS c
  ),
  landxml_agg AS (
    SELECT
      COALESCE(SUM(size_bytes), 0)::BIGINT AS b,
      COUNT(*)::BIGINT AS c
    FROM public.landxml_files
    WHERE farm_id = p_farm_id
  )
  SELECT
    p.b, p.c,
    r.b, r.c,
    o.b, o.c,
    l.b, l.c,
    (p.b + r.b + o.b + l.b),
    (p.c + r.c + o.c + l.c)
  FROM photo_agg p, registry_agg r, other_agg o, landxml_agg l;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_farm_storage_usage(UUID) TO authenticated;
