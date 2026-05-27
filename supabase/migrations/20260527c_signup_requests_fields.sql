-- 申し込みフォームに 郵便番号・住所・業種 を追加
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT;
