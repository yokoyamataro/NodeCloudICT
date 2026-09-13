-- メンバー ごと に 使える 製品 を 割り当てる。 1 人 で 複数 可。
--
-- 契約側 は organization_products.seat_limit (製品ごと の 人数上限)。
-- こちら は 「誰が その 枠 を 使うか」。 両方 揃って はじめて
-- 「土木は 5 人 まで」 と いった 管理 が 成り立つ。
--
-- 保持方法: organization_members に text[] を 1 本 足す。
-- 1 人あたり 最大 3 要素 なので 別表 に する ほど では ない。

ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS products TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.organization_members
  DROP CONSTRAINT IF EXISTS organization_members_products_check;
ALTER TABLE public.organization_members
  ADD CONSTRAINT organization_members_products_check
  CHECK (products <@ ARRAY['cadastral', 'civil', 'mobility']::TEXT[]);

COMMENT ON COLUMN public.organization_members.products IS
  'この メンバー が 使える 製品 (cadastral / civil / mobility)。 複数可。 空 = 未割当';

-- ============================================================
-- list_org_members: products を 返す ように 作り直す
-- ============================================================
DROP FUNCTION IF EXISTS public.list_org_members(uuid);

CREATE OR REPLACE FUNCTION public.list_org_members(p_org_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  role text,
  joined_at timestamptz,
  invited_by uuid,
  last_sign_in_at timestamptz,
  last_seen_at timestamptz,
  products text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_org_id)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT
      om.user_id,
      u.email::text AS email,
      p.full_name,
      p.phone,
      om.role,
      om.joined_at,
      om.invited_by,
      u.last_sign_in_at,
      p.last_seen_at,
      om.products
    FROM public.organization_members om
    JOIN auth.users u ON u.id = om.user_id
    LEFT JOIN public.profiles p ON p.user_id = om.user_id
    WHERE om.organization_id = p_org_id
    ORDER BY
      CASE om.role WHEN 'admin' THEN 0 ELSE 1 END,
      om.joined_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_org_members(uuid) TO authenticated;

-- ============================================================
-- org_set_member_products(p_org_id, p_user_id, p_products)
--   割り当て の 変更。 組織 admin と サイトオーナー が 実行 できる。
--   製品ごと の 人数上限 (organization_products.seat_limit) を 超える
--   割り当て は 拒否 する。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_set_member_products(
  p_org_id uuid,
  p_user_id uuid,
  p_products text[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product text;
  v_limit int;
  v_used int;
BEGIN
  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_org_id)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF NOT (COALESCE(p_products, '{}') <@ ARRAY['cadastral', 'civil', 'mobility']::TEXT[]) THEN
    RAISE EXCEPTION 'invalid product';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = p_org_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;

  -- 新しく 付ける 製品 だけ 上限 を 見る (既に 付いて いる ぶん は 数え直さない)
  FOREACH v_product IN ARRAY COALESCE(p_products, '{}')
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = p_org_id
        AND user_id = p_user_id
        AND v_product = ANY(products)
    ) THEN
      CONTINUE;
    END IF;

    SELECT seat_limit INTO v_limit
    FROM public.organization_products
    WHERE organization_id = p_org_id AND product = v_product;

    IF v_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_used
      FROM public.organization_members
      WHERE organization_id = p_org_id AND v_product = ANY(products);

      IF v_used >= v_limit THEN
        RAISE EXCEPTION 'seat_limit_exceeded:%:%', v_product, v_limit;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.organization_members
  SET products = COALESCE(p_products, '{}')
  WHERE organization_id = p_org_id AND user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.org_set_member_products(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_set_member_products(uuid, uuid, text[]) TO authenticated;
