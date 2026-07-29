-- handle_pending_invitations: profiles 行を organization_members INSERT より
-- 先に確保し、admin-first-member ケースでの validate_org_admin_membership
-- による EXCEPTION を回避する。
--
-- 発火経路 (バグ再現):
--   auth.users INSERT
--     ├─ on_auth_user_created_pending_invitations (アルファベット順で先)
--     │   handle_pending_invitations
--     │     └─ INSERT organization_members (org, new_user, 'admin')
--     │         └─ trg_org_members_sync_admin
--     │             └─ UPDATE organizations SET admin_user_id = new_user  ← admin ゼロだった組織で発火
--     │                 └─ trg_organizations_validate_admin
--     │                     └─ profiles.organization_id を検査 → 行なし → RAISE EXCEPTION
--     └─ on_auth_user_created_profile
--         └─ (ここで profiles 行が作られるが、既に上で失敗して届かない)
--
-- 修正:
--   handle_pending_invitations 側で「organization_members INSERT する前に
--   profiles 行を用意」する。UPSERT で作成、既存なら organization_id が NULL
--   の場合のみ埋める。これで validate_org_admin_membership が通る。
--   後段の (c) は同じ処理を後追いでやっていたので統合して削除。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

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

    -- **重要**: organization_members INSERT の前に profiles 行を確保する。
    -- 「admin ロールで組織初メンバーになる」ケースで
    -- sync_organizations_admin_user_id → validate_org_admin_membership が
    -- profiles を参照するため、事前に organization_id をセットしておかないと
    -- RAISE EXCEPTION で auth.users INSERT ごと rollback される。
    INSERT INTO public.profiles (user_id, organization_id)
    VALUES (NEW.id, v_org.id)
    ON CONFLICT (user_id) DO UPDATE
      SET organization_id = COALESCE(public.profiles.organization_id, EXCLUDED.organization_id),
          updated_at = now();

    INSERT INTO public.organization_members (organization_id, user_id, role, invited_by)
    VALUES (v_org.id, NEW.id, v_inv.org_role, v_inv.invited_by)
    ON CONFLICT (organization_id, user_id) DO NOTHING;
  END LOOP;

  -- 旧 (c) は上のループで profiles を先に面倒見るようになったため削除。

  -- (d) 取り込んだ招待行を削除
  DELETE FROM public.pending_invitations
  WHERE email = v_email;

  RETURN NEW;
END;
$$;
