-- サイトオーナー 向け: ユーザー別 / 組織別 の 使用状況。
--
-- 「オーナーである 現場 (プロジェクト) の 数」 と 「その 配下の データ量」 を
-- ユーザー 単位 で 1 行 に する。 組織 は profiles.organization_id で 紐づけ、
-- 画面側 で まとめる。
--
-- 集計の 単位 は 「プロジェクトの 所有者 (projects.user_id)」。
-- 工区 (farms) にも user_id が ある が、そちら で 数えると 同じ データ を
-- 二重に 数えて しまう ので 使わない。
--
-- 含めない もの:
--   * オルソタイル … storage.objects を prefix 検索 する 必要が あり 重い
--     (get_farm_storage_usage も 同じ 理由で 除外して いる)
--   * ゴミ箱 の プロジェクト / 工区 (deleted_at IS NOT NULL)

CREATE OR REPLACE FUNCTION public.get_site_usage_by_user()
RETURNS TABLE (
  user_id UUID,
  user_name TEXT,
  user_email TEXT,
  organization_id UUID,
  organization_name TEXT,
  project_count BIGINT,
  farm_count BIGINT,
  coordinate_count BIGINT,
  attachment_bytes BIGINT,
  attachment_count BIGINT,
  landxml_bytes BIGINT,
  farm_file_bytes BIGINT,
  total_bytes BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_site_owner() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH live_projects AS (
    SELECT p.id, p.user_id
    FROM public.projects p
    WHERE p.deleted_at IS NULL
  ),
  -- 工区 → その 持ち主 (プロジェクトの オーナー)
  owned_farms AS (
    SELECT f.id AS farm_id, lp.user_id AS owner_id
    FROM public.farms f
    JOIN live_projects lp ON lp.id = f.project_id
    WHERE f.deleted_at IS NULL
  ),
  project_agg AS (
    SELECT lp.user_id AS owner_id, COUNT(*)::BIGINT AS c
    FROM live_projects lp
    GROUP BY lp.user_id
  ),
  farm_agg AS (
    SELECT o.owner_id, COUNT(*)::BIGINT AS c
    FROM owned_farms o
    GROUP BY o.owner_id
  ),
  coord_agg AS (
    SELECT o.owner_id, COUNT(*)::BIGINT AS c
    FROM public.design_coordinates dc
    JOIN owned_farms o ON o.farm_id = dc.farm_id
    GROUP BY o.owner_id
  ),
  -- 添付は entity_type ごとに 工区へ 辿る (get_farm_storage_usage と 同じ 構成)
  attach_rows AS (
    SELECT o.owner_id, a.byte_size
    FROM public.attachments a
    JOIN owned_farms o ON a.entity_id = o.farm_id
    WHERE a.entity_type = 'farm'
    UNION ALL
    SELECT o.owner_id, a.byte_size
    FROM public.attachments a
    JOIN public.design_coordinates dc ON dc.id = a.entity_id
    JOIN owned_farms o ON o.farm_id = dc.farm_id
    WHERE a.entity_type = 'coordinate'
    UNION ALL
    SELECT o.owner_id, a.byte_size
    FROM public.attachments a
    JOIN public.design_work_areas wa ON wa.id = a.entity_id
    JOIN owned_farms o ON o.farm_id = wa.farm_id
    WHERE a.entity_type = 'work_area'
  ),
  attach_agg AS (
    SELECT owner_id,
           COALESCE(SUM(byte_size), 0)::BIGINT AS b,
           COUNT(*)::BIGINT AS c
    FROM attach_rows
    GROUP BY owner_id
  ),
  landxml_agg AS (
    SELECT o.owner_id, COALESCE(SUM(l.size_bytes), 0)::BIGINT AS b
    FROM public.landxml_files l
    JOIN owned_farms o ON o.farm_id = l.farm_id
    GROUP BY o.owner_id
  ),
  file_agg AS (
    SELECT o.owner_id, COALESCE(SUM(ff.size_bytes), 0)::BIGINT AS b
    FROM public.farm_files ff
    JOIN owned_farms o ON o.farm_id = ff.farm_id
    GROUP BY o.owner_id
  )
  SELECT
    u.id,
    pr.full_name,
    u.email::TEXT,
    pr.organization_id,
    og.name,
    COALESCE(pa.c, 0),
    COALESCE(fa.c, 0),
    COALESCE(ca.c, 0),
    COALESCE(aa.b, 0),
    COALESCE(aa.c, 0),
    COALESCE(la.b, 0),
    COALESCE(fl.b, 0),
    (COALESCE(aa.b, 0) + COALESCE(la.b, 0) + COALESCE(fl.b, 0))
  FROM auth.users u
  LEFT JOIN public.profiles pr ON pr.user_id = u.id
  LEFT JOIN public.organizations og ON og.id = pr.organization_id
  LEFT JOIN project_agg pa ON pa.owner_id = u.id
  LEFT JOIN farm_agg fa ON fa.owner_id = u.id
  LEFT JOIN coord_agg ca ON ca.owner_id = u.id
  LEFT JOIN attach_agg aa ON aa.owner_id = u.id
  LEFT JOIN landxml_agg la ON la.owner_id = u.id
  LEFT JOIN file_agg fl ON fl.owner_id = u.id
  ORDER BY og.name NULLS LAST, pr.full_name NULLS LAST, u.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_site_usage_by_user() TO authenticated;
