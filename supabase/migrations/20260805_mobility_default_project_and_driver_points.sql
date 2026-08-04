-- ============================================================
-- 1) デフォルト「未分類」現場を組織ごとに自動作成
--    - すべての新規 organization に対して「未分類」プロジェクトを 1 件作成
--    - 既存の organization にも backfill で追加 (無ければ)
--    - 全員が使える共通プロジェクトとして扱う (メンバー管理不要)
-- 2) mobility_project_points_insert の RLS を緩和
--    - 従来: is_org_admin_of_mproject のみ INSERT 可
--    - 変更: is_org_member_of_mproject でも INSERT 可
--    - ドライバーからポイント登録を可能に。UPDATE/DELETE は admin のみで据え置き
-- ============================================================

-- 未分類プロジェクト作成関数
CREATE OR REPLACE FUNCTION public.ensure_default_mobility_project(
  p_org_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_id uuid;
  new_id uuid;
BEGIN
  SELECT id INTO existing_id
    FROM public.mobility_projects
    WHERE organization_id = p_org_id
      AND name = '未分類'
    LIMIT 1;
  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;
  INSERT INTO public.mobility_projects (organization_id, name, description, active)
    VALUES (p_org_id, '未分類', 'デフォルト現場 (ドライバーからのポイント登録先)', true)
    RETURNING id INTO new_id;
  RETURN new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.ensure_default_mobility_project(uuid) TO authenticated;

-- 新規組織作成時に未分類を自動作成するトリガ
CREATE OR REPLACE FUNCTION public.tg_create_default_mobility_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.ensure_default_mobility_project(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_organizations_default_mproject ON public.organizations;
CREATE TRIGGER trg_organizations_default_mproject
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_create_default_mobility_project();

-- 既存組織に対して backfill
DO $$
DECLARE
  o record;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.ensure_default_mobility_project(o.id);
  END LOOP;
END $$;

-- ============================================================
-- RLS 緩和: mobility_project_points の INSERT を org member に開放
-- ============================================================
DROP POLICY IF EXISTS mobility_project_points_insert ON public.mobility_project_points;
CREATE POLICY mobility_project_points_insert ON public.mobility_project_points FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_org_member_of_mproject(project_id)
  );

-- UPDATE / DELETE は admin のみで据え置き (再定義せず既存維持)
-- 参考:
--   mobility_project_points_update: is_site_owner() OR is_org_admin_of_mproject(project_id)
--   mobility_project_points_delete: is_site_owner() OR is_org_admin_of_mproject(project_id)
