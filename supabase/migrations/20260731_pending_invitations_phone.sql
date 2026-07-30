-- 電話番号での招待に対応するため pending_invitations に phone 列を追加し、
-- handle_pending_invitations トリガを phone マッチにも対応させる。
--
-- 経緯:
--   モビリティ機能で「電話番号 + SMS 認証」でドライバーを招待できるように
--   する要件が発生。既存の email ベース招待に加え、phone ベースの招待行を
--   保存できるようにする。トリガは新規 auth.users INSERT 時に email/phone
--   どちらか一致する pending 行を取り込む。
--
-- 追加/変更:
--   1. pending_invitations.phone (text, nullable) を追加
--   2. email も nullable 化 (phone だけの招待を許可)
--   3. CHECK: email or phone のどちらかは必須
--   4. UNIQUE (organization_id, phone) の部分索引を追加 (phone 招待の重複防止)
--   5. handle_pending_invitations トリガを phone マッチにも対応
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. 列追加 & 制約緩和
-- ============================================================
ALTER TABLE public.pending_invitations
  ADD COLUMN IF NOT EXISTS phone text;

-- 既存 email は NOT NULL だったが、phone のみ招待も許すため nullable 化
ALTER TABLE public.pending_invitations
  ALTER COLUMN email DROP NOT NULL;

-- email or phone のどちらかは必須
ALTER TABLE public.pending_invitations
  DROP CONSTRAINT IF EXISTS pending_invitations_contact_check;
ALTER TABLE public.pending_invitations
  ADD CONSTRAINT pending_invitations_contact_check
  CHECK (email IS NOT NULL OR phone IS NOT NULL);

-- phone 正規化 (E.164 相当を強く求めない: '+' で始まるか数字のみを許容)
ALTER TABLE public.pending_invitations
  DROP CONSTRAINT IF EXISTS pending_invitations_phone_format;
ALTER TABLE public.pending_invitations
  ADD CONSTRAINT pending_invitations_phone_format
  CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{8,15}$');

-- ============================================================
-- 2. UNIQUE (organization_id, phone) 部分索引
--    email 側は既に索引ありなので phone 側も対称に張る
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS pending_invitations_org_phone_uidx
  ON public.pending_invitations (organization_id, phone)
  WHERE organization_id IS NOT NULL AND phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_invitations_phone
  ON public.pending_invitations (phone)
  WHERE phone IS NOT NULL;

-- ============================================================
-- 3. handle_pending_invitations トリガを phone マッチに対応
--    NEW.email が NULL でも NEW.phone があれば取り込む。
--    profiles の初期作成 (organization_id セット) は既存ロジックを踏襲。
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_pending_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(COALESCE(NEW.email, ''));
  v_phone text := NEW.phone;
  v_inv record;
  v_org record;
  v_current_count int;
BEGIN
  -- (a) プロジェクト招待 → project_members (email マッチのみ)
  INSERT INTO public.project_members (project_id, user_id, role)
  SELECT pi.project_id, NEW.id, pi.role
  FROM public.pending_invitations pi
  WHERE pi.project_id IS NOT NULL
    AND pi.role IS NOT NULL
    AND pi.email IS NOT NULL AND v_email <> ''
    AND pi.email = v_email
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- (b) 組織招待 → organization_members に転記 (期限 + 上限をチェック)
  --   email or phone どちらか一致で取り込む
  FOR v_inv IN
    SELECT pi.organization_id, pi.org_role, pi.invited_by
    FROM public.pending_invitations pi
    WHERE pi.organization_id IS NOT NULL
      AND pi.org_role IS NOT NULL
      AND (
        (pi.email IS NOT NULL AND v_email <> '' AND pi.email = v_email)
        OR (pi.phone IS NOT NULL AND v_phone IS NOT NULL AND pi.phone = v_phone)
      )
  LOOP
    SELECT id, name, user_count_limit, expires_at
      INTO v_org
      FROM public.organizations
     WHERE id = v_inv.organization_id;
    IF v_org.id IS NULL THEN
      CONTINUE;
    END IF;

    IF v_org.expires_at IS NOT NULL AND v_org.expires_at < now() THEN
      RAISE NOTICE 'skipping expired org % for user %', v_org.name, NEW.id;
      CONTINUE;
    END IF;

    IF v_org.user_count_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_members
       WHERE organization_id = v_org.id;

      IF NOT EXISTS (
        SELECT 1 FROM public.organization_members
         WHERE organization_id = v_org.id AND user_id = NEW.id
      ) AND v_current_count >= v_org.user_count_limit THEN
        RAISE NOTICE 'skipping org % (user_count_limit reached) for user %', v_org.name, NEW.id;
        CONTINUE;
      END IF;
    END IF;

    -- profiles を先に用意 (validate_org_admin_membership 対策)
    INSERT INTO public.profiles (user_id, organization_id)
    VALUES (NEW.id, v_org.id)
    ON CONFLICT (user_id) DO UPDATE
      SET organization_id = COALESCE(public.profiles.organization_id, EXCLUDED.organization_id),
          updated_at = now();

    INSERT INTO public.organization_members (organization_id, user_id, role, invited_by)
    VALUES (v_org.id, NEW.id, v_inv.org_role, v_inv.invited_by)
    ON CONFLICT (organization_id, user_id) DO NOTHING;
  END LOOP;

  -- (d) 取り込んだ招待行を削除 (email or phone 一致)
  DELETE FROM public.pending_invitations
  WHERE (email IS NOT NULL AND v_email <> '' AND email = v_email)
     OR (phone IS NOT NULL AND v_phone IS NOT NULL AND phone = v_phone);

  RETURN NEW;
END;
$$;
