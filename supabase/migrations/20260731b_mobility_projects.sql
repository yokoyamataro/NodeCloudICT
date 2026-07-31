-- モビリティの運行現場 (mobility projects) 機能。
--
-- 概念:
--   ・組織 admin が「運行現場」を作成。1 現場に複数のポイント (土取場/採石場/
--     雪捨場/農場A 等) を登録できる。
--   ・現場にドライバー (社内 + 社外) を割当てられる。
--   ・割当てられたドライバーの端末にポイント一覧が表示され、選択すると
--     地図移動 → 自車画面で方向・距離を線表示。
--
-- 追加:
--   1. mobility_projects              現場マスタ (組織単位)
--   2. mobility_project_members       ドライバー割当
--   3. mobility_project_points        現場内ポイント (destination)
--   4. is_org_member_of_mproject / is_org_admin_of_mproject
--      SECURITY DEFINER ヘルパ (RLS の無限再帰対策)
--   5. 各テーブルの RLS
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. mobility_projects
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mobility_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mobility_projects IS
  '運行現場マスタ。組織 admin が作成、ドライバーの割当先。';

CREATE INDEX IF NOT EXISTS idx_mobility_projects_organization
  ON public.mobility_projects (organization_id) WHERE active = true;

CREATE OR REPLACE FUNCTION public.tg_mobility_projects_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_mobility_projects_touch ON public.mobility_projects;
CREATE TRIGGER trg_mobility_projects_touch BEFORE UPDATE ON public.mobility_projects
  FOR EACH ROW EXECUTE FUNCTION public.tg_mobility_projects_touch();

-- ============================================================
-- 2. mobility_project_members
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mobility_project_members (
  project_id uuid NOT NULL REFERENCES public.mobility_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('driver')) DEFAULT 'driver',
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

COMMENT ON TABLE public.mobility_project_members IS
  '運行現場のドライバー割当。社内/社外を問わず、user_id (auth.users) で紐付ける。';

CREATE INDEX IF NOT EXISTS idx_mobility_project_members_user
  ON public.mobility_project_members (user_id);

-- ============================================================
-- 3. mobility_project_points
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mobility_project_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.mobility_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text,                                -- 例: '土取場','採石場','雪捨場','農場A' (自由入力)
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  memo text,
  active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mobility_project_points IS
  '運行現場内のポイント (destination)。ドライバーが選択して自車から線表示。';

CREATE INDEX IF NOT EXISTS idx_mobility_project_points_project
  ON public.mobility_project_points (project_id, display_order)
  WHERE active = true;

CREATE OR REPLACE FUNCTION public.tg_mobility_project_points_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_mobility_project_points_touch ON public.mobility_project_points;
CREATE TRIGGER trg_mobility_project_points_touch BEFORE UPDATE ON public.mobility_project_points
  FOR EACH ROW EXECUTE FUNCTION public.tg_mobility_project_points_touch();

-- ============================================================
-- 4. RLS ヘルパ (SECURITY DEFINER で organization_members の再帰を回避)
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_org_member_of_mproject(
  p_project_id uuid,
  uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.mobility_projects mp
    WHERE mp.id = p_project_id
      AND public.is_org_member(mp.organization_id, uid)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin_of_mproject(
  p_project_id uuid,
  uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.mobility_projects mp
    WHERE mp.id = p_project_id
      AND public.is_admin_of_org(mp.organization_id, uid)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_member_of_mproject(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_admin_of_mproject(uuid, uuid) TO authenticated;

-- ============================================================
-- 5. RLS - mobility_projects
-- ============================================================
ALTER TABLE public.mobility_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobility_projects_select ON public.mobility_projects;
DROP POLICY IF EXISTS mobility_projects_insert ON public.mobility_projects;
DROP POLICY IF EXISTS mobility_projects_update ON public.mobility_projects;
DROP POLICY IF EXISTS mobility_projects_delete ON public.mobility_projects;

-- SELECT: 同組織メンバー全員
CREATE POLICY mobility_projects_select ON public.mobility_projects FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member(organization_id)
  );

-- INSERT/UPDATE/DELETE: 組織 admin
CREATE POLICY mobility_projects_insert ON public.mobility_projects FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
  );
CREATE POLICY mobility_projects_update ON public.mobility_projects FOR UPDATE
  TO authenticated
  USING (public.is_site_owner() OR public.is_admin_of_org(organization_id))
  WITH CHECK (public.is_site_owner() OR public.is_admin_of_org(organization_id));
CREATE POLICY mobility_projects_delete ON public.mobility_projects FOR DELETE
  TO authenticated
  USING (public.is_site_owner() OR public.is_admin_of_org(organization_id));

-- ============================================================
-- 6. RLS - mobility_project_members
-- ============================================================
ALTER TABLE public.mobility_project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobility_project_members_select ON public.mobility_project_members;
DROP POLICY IF EXISTS mobility_project_members_insert ON public.mobility_project_members;
DROP POLICY IF EXISTS mobility_project_members_update ON public.mobility_project_members;
DROP POLICY IF EXISTS mobility_project_members_delete ON public.mobility_project_members;

-- SELECT: 同組織メンバー全員 (自分の割当も他人の割当も見える)
CREATE POLICY mobility_project_members_select ON public.mobility_project_members FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member_of_mproject(project_id)
  );

CREATE POLICY mobility_project_members_insert ON public.mobility_project_members FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_org_admin_of_mproject(project_id)
  );
CREATE POLICY mobility_project_members_update ON public.mobility_project_members FOR UPDATE
  TO authenticated
  USING (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id))
  WITH CHECK (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id));
CREATE POLICY mobility_project_members_delete ON public.mobility_project_members FOR DELETE
  TO authenticated
  USING (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id));

-- ============================================================
-- 7. RLS - mobility_project_points
-- ============================================================
ALTER TABLE public.mobility_project_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobility_project_points_select ON public.mobility_project_points;
DROP POLICY IF EXISTS mobility_project_points_insert ON public.mobility_project_points;
DROP POLICY IF EXISTS mobility_project_points_update ON public.mobility_project_points;
DROP POLICY IF EXISTS mobility_project_points_delete ON public.mobility_project_points;

-- SELECT: 同組織メンバー全員
CREATE POLICY mobility_project_points_select ON public.mobility_project_points FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member_of_mproject(project_id)
  );

CREATE POLICY mobility_project_points_insert ON public.mobility_project_points FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_org_admin_of_mproject(project_id)
  );
CREATE POLICY mobility_project_points_update ON public.mobility_project_points FOR UPDATE
  TO authenticated
  USING (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id))
  WITH CHECK (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id));
CREATE POLICY mobility_project_points_delete ON public.mobility_project_points FOR DELETE
  TO authenticated
  USING (public.is_site_owner() OR public.is_org_admin_of_mproject(project_id));
