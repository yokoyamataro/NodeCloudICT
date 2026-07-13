-- 組織メンバー制の導入。組織 (organizations) に対して複数の管理者 / 一般
-- ユーザーを紐付けられるようにする。
--
-- 設計方針 (ユーザー確定):
--   * organizations.admin_user_id は当面残す (レガシー互換)。organization_members
--     の admin ロールと自動同期するためトリガを張る。
--   * 招待時、対象メールのユーザーが既に別組織に所属していたらエラー (併属不可)。
--   * 「メンバー削除」= organization_members から DELETE + profiles.organization_id
--     を NULL に。auth.users は残す (ユーザー物理削除はサイトオーナー限定機能)。
--
-- 追加/変更点:
--   1. public.organization_members テーブル
--   2. is_org_admin(uid) / is_admin_of_org(org_id, uid) SQL 関数
--   3. 既存の admin_user_id + profiles.organization_id からバックフィル
--   4. organizations.admin_user_id を organization_members.role='admin' と同期する
--      双方向トリガ
--   5. pending_invitations に organization_id + org_role 列を追加
--      (project_id を nullable に変更、両方 NULL は不可の CHECK)
--   6. handle_pending_invitations 関数を拡張:
--      - project 招待 → project_members に転記 (既存動作)
--      - 組織招待 → organization_members に転記 + profiles.organization_id セット
--   7. organization_members / 拡張 pending_invitations の RLS
--   8. 組織管理者が自組織メンバーの profiles を UPDATE できるように RLS を拡張

-- ============================================================
-- 1. organization_members テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organization_members (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user
  ON public.organization_members (user_id);

-- ============================================================
-- 2. 権限判定 SQL 関数
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_org_admin(uid uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id = uid AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin_of_org(
  org_id uuid,
  uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = uid
      AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_of_org(uuid, uuid) TO authenticated;

-- ============================================================
-- 3. 既存データからのバックフィル
-- ============================================================
-- (a) organizations.admin_user_id → organization_members(role='admin')
INSERT INTO public.organization_members (organization_id, user_id, role, joined_at)
SELECT o.id, o.admin_user_id, 'admin', o.created_at
FROM public.organizations o
WHERE o.admin_user_id IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- (b) profiles.organization_id → organization_members(role='member')
--     ただし既に admin として登録済みならスキップ (ON CONFLICT DO NOTHING)。
INSERT INTO public.organization_members (organization_id, user_id, role, joined_at)
SELECT p.organization_id, p.user_id, 'member', p.created_at
FROM public.profiles p
WHERE p.organization_id IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- ============================================================
-- 4. organizations.admin_user_id 同期トリガ
-- ============================================================
-- organization_members に admin ロールが INSERT/UPDATE されたとき、
-- organizations.admin_user_id がまだ空 or 参照先が admin で無くなっていれば
-- 新しい admin にセットし直す。
-- また DELETE / UPDATE で admin が減った結果、admin_user_id が孤児になったら
-- 別の admin に付け替える (誰も居なければ NULL)。
CREATE OR REPLACE FUNCTION public.sync_organizations_admin_user_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_current_admin uuid;
  v_promote uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSE
    v_org_id := NEW.organization_id;
  END IF;

  SELECT admin_user_id INTO v_current_admin
  FROM public.organizations
  WHERE id = v_org_id;

  -- admin_user_id が現在 admin ロールを保持しているか
  IF v_current_admin IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id = v_current_admin
      AND role = 'admin'
  ) THEN
    -- 現状のままで問題無し
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- 他の admin から 1 名選んで昇格 (無ければ NULL)
  SELECT user_id INTO v_promote
  FROM public.organization_members
  WHERE organization_id = v_org_id AND role = 'admin'
  ORDER BY joined_at ASC
  LIMIT 1;

  UPDATE public.organizations
  SET admin_user_id = v_promote
  WHERE id = v_org_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_org_members_sync_admin ON public.organization_members;
CREATE TRIGGER trg_org_members_sync_admin
  AFTER INSERT OR UPDATE OR DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_organizations_admin_user_id();

-- ============================================================
-- 5. pending_invitations の列追加 (組織招待対応)
-- ============================================================
ALTER TABLE public.pending_invitations
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS org_role text CHECK (org_role IN ('admin', 'member'));

-- project_id を nullable にする (組織招待のみのケースを許可)
ALTER TABLE public.pending_invitations
  ALTER COLUMN project_id DROP NOT NULL;

-- 少なくとも project or organization のどちらかは必須
ALTER TABLE public.pending_invitations
  DROP CONSTRAINT IF EXISTS pending_invitations_target_check;
ALTER TABLE public.pending_invitations
  ADD CONSTRAINT pending_invitations_target_check
  CHECK (project_id IS NOT NULL OR organization_id IS NOT NULL);

-- project_role (既存の role 列) が project_id NULL の時は不要になるので nullable 化
ALTER TABLE public.pending_invitations
  ALTER COLUMN role DROP NOT NULL;

-- project 招待なら role 必須 / org 招待なら org_role 必須
ALTER TABLE public.pending_invitations
  DROP CONSTRAINT IF EXISTS pending_invitations_role_consistency;
ALTER TABLE public.pending_invitations
  ADD CONSTRAINT pending_invitations_role_consistency
  CHECK (
    (project_id IS NULL OR role IS NOT NULL)
    AND
    (organization_id IS NULL OR org_role IS NOT NULL)
  );

-- 検索用 index
CREATE INDEX IF NOT EXISTS idx_pending_invitations_organization
  ON public.pending_invitations (organization_id);

-- ============================================================
-- 6. handle_pending_invitations 関数を拡張
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_pending_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(NEW.email);
BEGIN
  -- (a) プロジェクト招待 → project_members に転記
  INSERT INTO public.project_members (project_id, user_id, role)
  SELECT pi.project_id, NEW.id, pi.role
  FROM public.pending_invitations pi
  WHERE pi.email = v_email
    AND pi.project_id IS NOT NULL
    AND pi.role IS NOT NULL
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- (b) 組織招待 → organization_members に転記
  INSERT INTO public.organization_members (organization_id, user_id, role, invited_by)
  SELECT pi.organization_id, NEW.id, pi.org_role, pi.invited_by
  FROM public.pending_invitations pi
  WHERE pi.email = v_email
    AND pi.organization_id IS NOT NULL
    AND pi.org_role IS NOT NULL
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- (c) 組織招待があった場合、profiles.organization_id もセット
  UPDATE public.profiles p
  SET organization_id = pi.organization_id,
      updated_at = now()
  FROM public.pending_invitations pi
  WHERE p.user_id = NEW.id
    AND pi.email = v_email
    AND pi.organization_id IS NOT NULL
    AND p.organization_id IS NULL;

  -- (d) 取り込んだ招待行を削除
  DELETE FROM public.pending_invitations
  WHERE email = v_email;

  RETURN NEW;
END;
$$;

-- 既存トリガをそのまま流用 (関数のみ CREATE OR REPLACE で上書き済み)。

-- ============================================================
-- 7. RLS - organization_members
-- ============================================================
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_members_select ON public.organization_members;
DROP POLICY IF EXISTS organization_members_insert ON public.organization_members;
DROP POLICY IF EXISTS organization_members_update ON public.organization_members;
DROP POLICY IF EXISTS organization_members_delete ON public.organization_members;

-- SELECT: サイトオーナー全件、同組織メンバー全員は互いを見える
CREATE POLICY organization_members_select ON public.organization_members FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.organization_members me
      WHERE me.user_id = auth.uid()
        AND me.organization_id = organization_members.organization_id
    )
  );

-- INSERT: サイトオーナー、または対象組織の admin
CREATE POLICY organization_members_insert ON public.organization_members FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
  );

-- UPDATE: サイトオーナー、または対象組織の admin
--   ただし「最後の admin を降格 / 削除」は許さない (下記 role='admin' 制約と併用)
CREATE POLICY organization_members_update ON public.organization_members FOR UPDATE
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
  )
  WITH CHECK (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
  );

-- DELETE: サイトオーナー、または対象組織の admin、または本人 (自ら脱退)
CREATE POLICY organization_members_delete ON public.organization_members FOR DELETE
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
    OR user_id = auth.uid()
  );

-- ============================================================
-- 8. RLS - pending_invitations 拡張
--    組織招待レコード (project_id IS NULL) は組織 admin もアクセス可
-- ============================================================
DROP POLICY IF EXISTS pending_invitations_select ON public.pending_invitations;
DROP POLICY IF EXISTS pending_invitations_insert ON public.pending_invitations;
DROP POLICY IF EXISTS pending_invitations_delete ON public.pending_invitations;

CREATE POLICY pending_invitations_select ON public.pending_invitations FOR SELECT
  USING (
    public.is_site_owner()
    OR (project_id IS NOT NULL AND public.is_project_owner(project_id))
    OR (organization_id IS NOT NULL AND public.is_admin_of_org(organization_id))
  );

CREATE POLICY pending_invitations_insert ON public.pending_invitations FOR INSERT
  WITH CHECK (
    public.is_site_owner()
    OR (project_id IS NOT NULL AND public.is_project_owner(project_id))
    OR (organization_id IS NOT NULL AND public.is_admin_of_org(organization_id))
  );

CREATE POLICY pending_invitations_delete ON public.pending_invitations FOR DELETE
  USING (
    public.is_site_owner()
    OR (project_id IS NOT NULL AND public.is_project_owner(project_id))
    OR (organization_id IS NOT NULL AND public.is_admin_of_org(organization_id))
  );

-- ============================================================
-- 9. profiles の RLS 拡張
--    組織管理者は自組織メンバーの profiles を SELECT / UPDATE できる
--    (メンバー一覧画面で氏名を編集するため)
-- ============================================================
-- 既存 SELECT ポリシー (本人 + サイトオーナー) は残しつつ、追加ポリシーを重ねる
DROP POLICY IF EXISTS profiles_select_org_admin ON public.profiles;
CREATE POLICY profiles_select_org_admin ON public.profiles FOR SELECT
  TO authenticated
  USING (
    -- 自組織の admin なら SELECT 可
    organization_id IS NOT NULL
    AND public.is_admin_of_org(organization_id)
  );

DROP POLICY IF EXISTS profiles_update_org_admin ON public.profiles;
CREATE POLICY profiles_update_org_admin ON public.profiles FOR UPDATE
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND public.is_admin_of_org(organization_id)
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND public.is_admin_of_org(organization_id)
  );
