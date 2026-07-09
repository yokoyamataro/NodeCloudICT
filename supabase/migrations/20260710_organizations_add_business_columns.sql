-- 組織 (organizations) に業務上の管理項目を追加する。
--
-- 追加列:
--   phone            電話番号
--   address          住所
--   representative   代表者氏名
--   admin_user_id    管理者ユーザー (auth.users への参照)
--   user_count_limit 契約ユーザー数
--   plan             プラン (自由入力テキスト)
--
-- 注記:
--   user_count_limit / plan は現時点では単なる管理データで、他の挙動には影響しない。
--   将来的にプラン別権限制御などへ拡張する余地を残すため個別列にしている。

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS representative text,
  ADD COLUMN IF NOT EXISTS admin_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_count_limit integer,
  ADD COLUMN IF NOT EXISTS plan text;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_user_count_nonneg;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_user_count_nonneg
  CHECK (user_count_limit IS NULL OR user_count_limit >= 0);

CREATE INDEX IF NOT EXISTS idx_organizations_admin_user
  ON public.organizations (admin_user_id);
