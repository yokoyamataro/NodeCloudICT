-- 「最終ログイン」 が 実際の 利用 と ずれる 問題 への 対処。
--
-- auth.users.last_sign_in_at は GoTrue が 「サインイン処理」 を した ときだけ
-- 更新する。 セッション は 自動で リフレッシュ される ので、毎日 使って いても
-- 何週間 も 前の 日付 の まま に なる。 これでは 稼働状況 が 分からない。
--
-- そこで profiles.last_seen_at を 自前で 持つ。 アプリ 起動時 に
-- touch_last_seen() を 呼ぶ (クライアント側 でも 間引く)。

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.last_seen_at IS
  '最後に アプリ を 使った 日時。 auth.users.last_sign_in_at (サインイン処理の 日時) とは 別物';

-- 自分の 行 を 更新 する だけ。 10 分 以内 の 再呼び出し は 何も しない
-- (起動の たび に UPDATE が 走る のを 抑える)。
CREATE OR REPLACE FUNCTION public.touch_last_seen()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.profiles (user_id, last_seen_at)
  VALUES (auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET last_seen_at = now()
    WHERE public.profiles.last_seen_at IS NULL
       OR public.profiles.last_seen_at < now() - INTERVAL '10 minutes';
END;
$$;

GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;

-- ============================================================
-- list_org_members: last_seen_at を 返す ように 作り直す
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
  last_seen_at timestamptz
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
      p.last_seen_at
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
