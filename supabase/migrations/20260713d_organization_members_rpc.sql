-- 組織メンバー操作用の RPC 追加。
-- 20260713c で作った organization_members / RLS の上に、AdminUsersPage
-- から呼びやすい形の SECURITY DEFINER 関数を並べる。
--
-- 権限モデル:
--   * サイトオーナー (is_site_owner)  → 任意の組織メンバーを閲覧・編集可
--   * 組織 admin (is_admin_of_org)   → 自組織メンバーのみ閲覧・編集可
--   * それ以外                         → 実行不可 (RPC 内でエラー)

-- ============================================================
-- 1. list_org_members(p_org_id)
--    指定組織のメンバー一覧 (email + full_name + role + joined_at)
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_org_members(p_org_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  role text,
  joined_at timestamptz,
  invited_by uuid,
  last_sign_in_at timestamptz
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
      om.role,
      om.joined_at,
      om.invited_by,
      u.last_sign_in_at
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
-- 2. list_my_admin_org_ids()
--    現在のユーザーが admin ロールを持つ組織の一覧 (通常 1 個)
--    UI で「どの組織のメンバーページを開くか」を決めるのに使う。
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_my_admin_org_ids()
RETURNS TABLE (
  organization_id uuid,
  organization_name text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT om.organization_id, o.name
  FROM public.organization_members om
  JOIN public.organizations o ON o.id = om.organization_id
  WHERE om.user_id = auth.uid()
    AND om.role = 'admin'
  ORDER BY o.name;
$$;

GRANT EXECUTE ON FUNCTION public.list_my_admin_org_ids() TO authenticated;

-- ============================================================
-- 3. org_admin_set_full_name(target_user_id, full_name)
--    組織 admin が自組織メンバーの氏名を更新する。
--    サイトオーナーも呼べる (どの組織メンバーでも編集可)。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_admin_set_full_name(
  p_user_id uuid,
  p_full_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_org uuid;
BEGIN
  SELECT organization_id INTO v_target_org
  FROM public.profiles
  WHERE user_id = p_user_id;

  IF NOT (
    public.is_site_owner()
    OR (v_target_org IS NOT NULL AND public.is_admin_of_org(v_target_org))
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  INSERT INTO public.profiles (user_id, full_name)
  VALUES (p_user_id, p_full_name)
  ON CONFLICT (user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.org_admin_set_full_name(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_admin_set_full_name(uuid, text) TO authenticated;

-- ============================================================
-- 4. org_add_existing_user(p_org_id, p_email, p_role)
--    既に auth.users に居る (アプリに登録済み) ユーザーを組織に追加する。
--    併属禁止のため他組織所属者を追加しようとするとエラー。
--    サイトオーナー or 組織 admin のみ実行可。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_add_existing_user(
  p_org_id uuid,
  p_email text,
  p_role text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_user uuid;
  v_current_org uuid;
BEGIN
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;

  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_org_id)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id INTO v_target_user
  FROM auth.users
  WHERE lower(email) = lower(p_email);

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'user_not_registered';
  END IF;

  SELECT organization_id INTO v_current_org
  FROM public.profiles
  WHERE user_id = v_target_user;

  IF v_current_org IS NOT NULL AND v_current_org <> p_org_id THEN
    RAISE EXCEPTION 'user_belongs_to_other_org';
  END IF;

  INSERT INTO public.organization_members
    (organization_id, user_id, role, invited_by)
  VALUES (p_org_id, v_target_user, p_role, auth.uid())
  ON CONFLICT (organization_id, user_id) DO UPDATE
    SET role = EXCLUDED.role;

  -- profiles.organization_id が空だったらこの組織にセット
  INSERT INTO public.profiles (user_id, organization_id)
  VALUES (v_target_user, p_org_id)
  ON CONFLICT (user_id) DO UPDATE
    SET organization_id = COALESCE(profiles.organization_id, EXCLUDED.organization_id),
        updated_at = now();

  RETURN v_target_user;
END;
$$;

REVOKE ALL ON FUNCTION public.org_add_existing_user(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_add_existing_user(uuid, text, text) TO authenticated;

-- ============================================================
-- 5. org_remove_member(p_org_id, p_user_id)
--    組織からメンバーを外す。profiles.organization_id も NULL に。
--    auth.users は残す (物理削除はサイトオーナーだけの別 RPC/Edge)。
--    最後の admin を削除しようとするとエラー (組織を無管理者にしない安全策)。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_remove_member(
  p_org_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_role text;
  v_admin_count integer;
BEGIN
  IF NOT (
    public.is_site_owner()
    OR public.is_admin_of_org(p_org_id)
    OR p_user_id = auth.uid()  -- 自ら脱退
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT role INTO v_target_role
  FROM public.organization_members
  WHERE organization_id = p_org_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RETURN;
  END IF;

  IF v_target_role = 'admin' THEN
    SELECT COUNT(*) INTO v_admin_count
    FROM public.organization_members
    WHERE organization_id = p_org_id AND role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'cannot_remove_last_admin';
    END IF;
  END IF;

  DELETE FROM public.organization_members
  WHERE organization_id = p_org_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET organization_id = NULL,
      updated_at = now()
  WHERE user_id = p_user_id
    AND organization_id = p_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.org_remove_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_remove_member(uuid, uuid) TO authenticated;

-- ============================================================
-- 6. org_change_member_role(p_org_id, p_user_id, p_role)
--    メンバーのロール変更 (admin ⇔ member)。
--    最後の admin を降格しようとするとエラー。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_change_member_role(
  p_org_id uuid,
  p_user_id uuid,
  p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_role text;
  v_admin_count integer;
BEGIN
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;

  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_org_id)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT role INTO v_current_role
  FROM public.organization_members
  WHERE organization_id = p_org_id AND user_id = p_user_id;

  IF v_current_role IS NULL THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;

  IF v_current_role = p_role THEN
    RETURN;
  END IF;

  IF v_current_role = 'admin' AND p_role = 'member' THEN
    SELECT COUNT(*) INTO v_admin_count
    FROM public.organization_members
    WHERE organization_id = p_org_id AND role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'cannot_demote_last_admin';
    END IF;
  END IF;

  UPDATE public.organization_members
  SET role = p_role
  WHERE organization_id = p_org_id AND user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.org_change_member_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_change_member_role(uuid, uuid, text) TO authenticated;
