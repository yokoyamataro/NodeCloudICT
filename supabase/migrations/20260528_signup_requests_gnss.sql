-- 申し込みフォームに利用環境（Android端末・Drogger・GNSS補正情報）を追加
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS has_android TEXT,      -- 'はい' / 'いいえ'
  ADD COLUMN IF NOT EXISTS has_drogger TEXT,      -- 'はい' / 'いいえ'
  ADD COLUMN IF NOT EXISTS gnss_correction TEXT;  -- VRS / softbank(ichimil) / docomo / au / 固定局設置 / 未定
