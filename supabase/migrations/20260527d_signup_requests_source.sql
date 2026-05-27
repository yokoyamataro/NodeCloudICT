-- 申し込みフォームに「NodeCloud を知ったきっかけ」を追加
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS source TEXT;
