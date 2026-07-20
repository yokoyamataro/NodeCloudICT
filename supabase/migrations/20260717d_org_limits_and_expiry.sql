-- 組織のユーザー数上限と利用期限を強制するための migration。
--
-- 追加:
--   1. organizations.expires_at (timestamptz, nullable): サイトオーナーが
--      組織ごとに設定できる利用期限。NULL は無期限。now() > expires_at で
--      「期限切れ」扱いになり、以降の新規メンバー追加を拒否する。
--   2. org_add_existing_user RPC を拡張し、user_count_limit と expires_at の
--      両方を厳格チェック。超過/期限切れなら例外を投げる。
--   3. handle_pending_invitations トリガも同じチェックを追加。事前招待
--      された未登録ユーザーが後から signup したときに、いつの間にか
--      上限を超えたり期限切れ組織に追加されたりする事故を防ぐ。

-- ============================================================
-- 1. 列追加
-- ============================================================
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.organizations.expires_at IS
  '組織の利用期限 (JST 想定)。NULL は無期限。now() > expires_at で新規
   メンバー追加が拒否される (既存メンバーの閲覧・編集は影響しない)。';

-- ============================================================
-- 2. org_add_existing_user: 上限 + 期限チェック
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
  v_org record;
  v_current_count int;
BEGIN
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;

  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_org_id)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id, name, user_count_limit, expires_at
    INTO v_org
    FROM public.organizations
   WHERE id = p_org_id;
  IF v_org.id IS NULL THEN
    RAISE EXCEPTION 'organization_not_found';
  END IF;

  -- 期限チェック
  IF v_org.expires_at IS NOT NULL AND v_org.expires_at < now() THEN
    RAISE EXCEPTION 'org_expired: 組織 % の利用期限 (%) を過ぎているため追加できません', v_org.name, v_org.expires_at;
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

  -- 上限チェック (既にメンバーの場合はロール更新のみで済むので count 増えず OK)
  IF v_org.user_count_limit IS NOT NULL THEN
    SELECT COUNT(*) INTO v_current_count
      FROM public.organization_members
     WHERE organization_id = p_org_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.organization_members
       WHERE organization_id = p_org_id AND user_id = v_target_user
    ) AND v_current_count >= v_org.user_count_limit THEN
      RAISE EXCEPTION 'org_user_limit_reached: 組織 % のユーザー数上限 (%/%) に達しています', v_org.name, v_current_count, v_org.user_count_limit;
    END IF;
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

-- ============================================================
-- 3. handle_pending_invitations: 組織側の (b) INSERT にも同じチェック
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_pending_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(NEW.email);
  v_inv record;
  v_org record;
  v_current_count int;
BEGIN
  -- (a) プロジェクト招待 → project_members に転記
  INSERT INTO public.project_members (project_id, user_id, role)
  SELECT pi.project_id, NEW.id, pi.role
  FROM public.pending_invitations pi
  WHERE pi.email = v_email
    AND pi.project_id IS NOT NULL
    AND pi.role IS NOT NULL
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- (b) 組織招待 → organization_members に転記 (期限 + 上限をチェック)
  FOR v_inv IN
    SELECT pi.organization_id, pi.org_role, pi.invited_by
    FROM public.pending_invitations pi
    WHERE pi.email = v_email
      AND pi.organization_id IS NOT NULL
      AND pi.org_role IS NOT NULL
  LOOP
    SELECT id, name, user_count_limit, expires_at
      INTO v_org
      FROM public.organizations
     WHERE id = v_inv.organization_id;
    IF v_org.id IS NULL THEN
      CONTINUE;
    END IF;

    -- 期限切れ → skip
    IF v_org.expires_at IS NOT NULL AND v_org.expires_at < now() THEN
      RAISE NOTICE 'skipping expired org % for user %', v_org.name, v_email;
      CONTINUE;
    END IF;

    -- 上限超過 → skip (既メンバーの場合はカウント不要)
    IF v_org.user_count_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_members
       WHERE organization_id = v_org.id;

      IF NOT EXISTS (
        SELECT 1 FROM public.organization_members
         WHERE organization_id = v_org.id AND user_id = NEW.id
      ) AND v_current_count >= v_org.user_count_limit THEN
        RAISE NOTICE 'skipping org % (user_count_limit reached) for user %', v_org.name, v_email;
        CONTINUE;
      END IF;
    END IF;

    INSERT INTO public.organization_members (organization_id, user_id, role, invited_by)
    VALUES (v_org.id, NEW.id, v_inv.org_role, v_inv.invited_by)
    ON CONFLICT (organization_id, user_id) DO NOTHING;
  END LOOP;

  -- (c) 組織招待があった場合、profiles.organization_id もセット
  UPDATE public.profiles p
  SET organization_id = pi.organization_id,
      updated_at = now()
  FROM public.pending_invitations pi
  WHERE p.user_id = NEW.id
    AND pi.email = v_email
    AND pi.organization_id IS NOT NULL
    AND p.organization_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_members om
       WHERE om.organization_id = pi.organization_id AND om.user_id = NEW.id
    );

  -- (d) 取り込んだ招待行を削除
  DELETE FROM public.pending_invitations
  WHERE email = v_email;

  RETURN NEW;
END;
$$;
