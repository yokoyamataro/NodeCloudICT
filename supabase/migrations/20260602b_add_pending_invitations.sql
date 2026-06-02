-- 招待リンクでユーザーをプロジェクトに招く仕組み。
--
-- フロー:
--   1. オーナーが「メール + 権限」で招待 → Edge Function `invite-member` が
--      service_role で auth.admin.inviteUserByEmail を呼び、メールリンクを発送。
--      同時に pending_invitations にレコードを保存しておく。
--   2. 招待された人がメール内リンクを踏み Supabase でパスワードを設定 → auth.users
--      に新規行ができる。
--   3. 下記トリガが auth.users への INSERT を拾い、対応する pending_invitations
--      を引いて project_members に転記し、pending 行を削除する。
--   4. 招待時にユーザーがすでに auth.users にいる場合は Edge Function 側で直接
--      project_members に INSERT してリンクは送らない。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行。

-- ========================================================================
-- 1. pending_invitations テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.pending_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lower(email))  -- 同じ project に同じメールは 1 件まで
);

CREATE INDEX IF NOT EXISTS idx_pending_invitations_email_lower
  ON public.pending_invitations ((lower(email)));

ALTER TABLE public.pending_invitations ENABLE ROW LEVEL SECURITY;

-- RLS: オーナー（is_project_owner）のみが SELECT / INSERT / DELETE 可能。
-- 招待される側（まだログイン前）は RLS を通らず、トリガで処理される。
DROP POLICY IF EXISTS "pending_invitations_select" ON public.pending_invitations;
DROP POLICY IF EXISTS "pending_invitations_insert" ON public.pending_invitations;
DROP POLICY IF EXISTS "pending_invitations_delete" ON public.pending_invitations;

CREATE POLICY "pending_invitations_select" ON public.pending_invitations FOR SELECT
  USING (public.is_project_owner(project_id));

CREATE POLICY "pending_invitations_insert" ON public.pending_invitations FOR INSERT
  WITH CHECK (public.is_project_owner(project_id));

CREATE POLICY "pending_invitations_delete" ON public.pending_invitations FOR DELETE
  USING (public.is_project_owner(project_id));

-- ========================================================================
-- 2. auth.users INSERT トリガ
--    SECURITY DEFINER で project_members の RLS を素通りして INSERT する。
-- ========================================================================
CREATE OR REPLACE FUNCTION public.handle_pending_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 新規ユーザーのメールに紐づく招待を project_members に転記
  INSERT INTO public.project_members (project_id, user_id, role)
  SELECT pi.project_id, NEW.id, pi.role
  FROM public.pending_invitations pi
  WHERE lower(pi.email) = lower(NEW.email)
  ON CONFLICT (project_id, user_id) DO NOTHING;

  -- 取り込んだ招待行を削除
  DELETE FROM public.pending_invitations
  WHERE lower(email) = lower(NEW.email);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_pending_invitations ON auth.users;
CREATE TRIGGER on_auth_user_created_pending_invitations
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_pending_invitations();
