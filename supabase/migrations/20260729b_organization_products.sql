-- 組織の製品別契約管理テーブル。
--
-- 目的:
--   NodeCloud は「地籍測量」「土木工事」「モビリティ」の 3 製品を提供予定で、
--   組織ごとに契約している製品が異なる (地籍だけ / モビリティだけ / 全部 等)。
--   これを 1 テーブルで表現し、以降の RLS・UI 出し分け・座席課金の
--   単一根拠にする。
--
-- 設計方針:
--   * organizations.user_count_limit / plan / expires_at は当面残す (急な廃止で
--     壊れるコードがある)。ただし、以後追加される機能はここではなく
--     organization_products を参照する。
--   * cadastral / civil は既存全組織にバックフィルするので、この migration 適用
--     直後は UX に影響が出ない。逆に mobility は明示的に契約行が入るまで有効に
--     ならない (= サイトオーナー以外は当面ゲート閉)。
--   * seat_limit は「その製品を使う人数」の上限。NULL は無制限。
--   * expires_at は「その製品の契約終了日」。NULL は無期限。
--
-- 追加:
--   1. public.organization_products テーブル
--   2. RLS (SELECT: 同一組織メンバー + サイトオーナー、
--          変更: サイトオーナーのみ (組織 admin への開放は次段階))
--   3. 既存組織へのバックフィル (cadastral + civil)
--   4. has_org_product(org_id, product) / i_have_product(product) SQL 関数
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organization_products (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product text NOT NULL CHECK (product IN ('cadastral', 'civil', 'mobility')),
  plan text,
  seat_limit int,                          -- NULL = 無制限
  starts_at timestamptz,
  expires_at timestamptz,                  -- NULL = 無期限
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product)
);

COMMENT ON TABLE public.organization_products IS
  '組織単位の製品別契約 (cadastral/civil/mobility)。座席上限と期限は製品ごとに独立。';
COMMENT ON COLUMN public.organization_products.seat_limit IS
  'この製品を利用する社員数の上限。NULL は無制限。';
COMMENT ON COLUMN public.organization_products.expires_at IS
  'この製品の契約終了 (JST 想定)。NULL は無期限。now() > expires_at で製品が
   非表示 (has_org_product が false を返す)。';

CREATE INDEX IF NOT EXISTS idx_organization_products_product
  ON public.organization_products (product);

-- 変更時に updated_at を自動更新
CREATE OR REPLACE FUNCTION public.tg_organization_products_touch()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_organization_products_touch ON public.organization_products;
CREATE TRIGGER trg_organization_products_touch
  BEFORE UPDATE ON public.organization_products
  FOR EACH ROW EXECUTE FUNCTION public.tg_organization_products_touch();

-- ============================================================
-- 2. RLS
-- ============================================================
ALTER TABLE public.organization_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_products_select ON public.organization_products;
DROP POLICY IF EXISTS organization_products_insert ON public.organization_products;
DROP POLICY IF EXISTS organization_products_update ON public.organization_products;
DROP POLICY IF EXISTS organization_products_delete ON public.organization_products;

-- SELECT: サイトオーナー全件、同組織メンバーは自組織の契約を閲覧可
CREATE POLICY organization_products_select ON public.organization_products FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.organization_members me
      WHERE me.user_id = auth.uid()
        AND me.organization_id = organization_products.organization_id
    )
  );

-- INSERT/UPDATE/DELETE: サイトオーナーのみ (契約管理は運営側)
--   組織 admin への開放は将来必要になったら追加する。
CREATE POLICY organization_products_insert ON public.organization_products FOR INSERT
  TO authenticated WITH CHECK (public.is_site_owner());
CREATE POLICY organization_products_update ON public.organization_products FOR UPDATE
  TO authenticated USING (public.is_site_owner()) WITH CHECK (public.is_site_owner());
CREATE POLICY organization_products_delete ON public.organization_products FOR DELETE
  TO authenticated USING (public.is_site_owner());

-- ============================================================
-- 3. 既存組織へのバックフィル
--    cadastral / civil を全組織に自動付与。契約情報は既存 organizations
--    の user_count_limit / expires_at / plan を流用する。
--    mobility は明示付与 (バックフィルしない)。
-- ============================================================
INSERT INTO public.organization_products (
  organization_id, product, plan, seat_limit, starts_at, expires_at
)
SELECT o.id, p.product, o.plan, o.user_count_limit, o.created_at, o.expires_at
FROM public.organizations o
CROSS JOIN (VALUES ('cadastral'), ('civil')) AS p(product)
ON CONFLICT (organization_id, product) DO NOTHING;

-- ============================================================
-- 4. 判定関数
-- ============================================================
-- 指定組織が指定製品を「現在利用可能」か
CREATE OR REPLACE FUNCTION public.has_org_product(
  p_org_id uuid,
  p_product text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_products
    WHERE organization_id = p_org_id
      AND product = p_product
      AND (expires_at IS NULL OR expires_at >= now())
  );
$$;

-- 呼び出し元 (auth.uid) が所属する組織が指定製品を利用可能か。
-- サイトオーナーは常に true。
CREATE OR REPLACE FUNCTION public.i_have_product(
  p_product text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_site_owner()
      OR EXISTS (
    SELECT 1
    FROM public.organization_products op
    JOIN public.organization_members om
      ON om.organization_id = op.organization_id
    WHERE om.user_id = auth.uid()
      AND op.product = p_product
      AND (op.expires_at IS NULL OR op.expires_at >= now())
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_org_product(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.i_have_product(text) TO authenticated;
