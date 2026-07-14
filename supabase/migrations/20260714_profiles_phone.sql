-- profiles に phone (電話番号) 列を追加。
-- 用途:
--   * 現時点: 組織メンバーの連絡先として保持・表示・編集
--   * 将来 : Supabase Phone Auth 有効化時、auth.users.phone に別途コピー
--           (現状はコピーしない。UI/Admin API 経由で必要になったら別 migration)
--
-- 保管場所:
--   profiles.phone (nullable, text)
--   フォーマット検証は行わず自由入力。UI 側で軽くバリデーション (数字 / ハイフン等)

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone text;

-- ============================================================
-- list_org_members RPC: phone 列を返すように再定義
-- 戻り値の型 (TABLE 列) が変わるので DROP FUNCTION が必須。
-- CREATE OR REPLACE だと "cannot change return type" で弾かれる。
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
      p.phone,
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

-- ============================================================
-- org_admin_set_phone(target_user_id, phone)
--   氏名編集 (org_admin_set_full_name) と同じ権限ロジックで
--   電話番号だけ更新する。本人 or 組織 admin or サイトオーナーが実行可。
-- ============================================================
CREATE OR REPLACE FUNCTION public.org_admin_set_phone(
  p_user_id uuid,
  p_phone text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_org uuid;
  v_normalized text;
BEGIN
  SELECT organization_id INTO v_target_org
  FROM public.profiles
  WHERE user_id = p_user_id;

  -- 権限: 本人 / 対象組織 admin / サイトオーナー
  IF NOT (
    auth.uid() = p_user_id
    OR public.is_site_owner()
    OR (v_target_org IS NOT NULL AND public.is_admin_of_org(v_target_org))
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- 正規化: NULL 相当 (空 / 空白のみ) は NULL に、それ以外は trim して保存
  v_normalized := NULLIF(trim(coalesce(p_phone, '')), '');

  INSERT INTO public.profiles (user_id, phone)
  VALUES (p_user_id, v_normalized)
  ON CONFLICT (user_id) DO UPDATE
    SET phone = EXCLUDED.phone,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.org_admin_set_phone(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_admin_set_phone(uuid, text) TO authenticated;

-- ============================================================
-- org_admin_set_full_name も本人による更新を許可 (整合性のため)
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
    auth.uid() = p_user_id
    OR public.is_site_owner()
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
