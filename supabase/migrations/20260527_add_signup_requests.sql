-- 紹介・申し込みページからのリード（問い合わせ）受付テーブル。
-- 未ログインの見込み客が INSERT できる。閲覧はログインユーザーのみ。
CREATE TABLE IF NOT EXISTS public.signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  user_count INT,
  plan_interest TEXT,           -- 'civil' | 'boundary' | 'undecided' など
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new / contacted / closed（対応管理用）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.signup_requests ENABLE ROW LEVEL SECURITY;

-- 申し込み（INSERT）は誰でも可。閲覧はログインユーザーのみ（ダッシュボード/管理画面で確認）。
DROP POLICY IF EXISTS signup_requests_insert ON public.signup_requests;
CREATE POLICY signup_requests_insert ON public.signup_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS signup_requests_select ON public.signup_requests;
CREATE POLICY signup_requests_select ON public.signup_requests
  FOR SELECT TO authenticated
  USING (true);

GRANT INSERT ON public.signup_requests TO anon, authenticated;
GRANT SELECT ON public.signup_requests TO authenticated;
