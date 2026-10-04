-- 組織 (organizations) と 申込 (signup_requests) の 住所 を 「都道府県」 と
-- 「区郡市町村以下」 に 分離 する。
--
-- 背景:
--   郵便番号 → 住所 の 自動 入力 で、 まず 都道府県 が 決まる こと が 多い。
--   都道府県 を 別 カラム に 分けて おくと、 集計 (都道府県別 の 会員数 等) や
--   検索 が やり やすい。
--   既存 の address は そのまま 「区郡市町村以下」 用途 として 残す。
--
-- 既存 行 は NULL の まま。 UI は 「都道府県 未設定」 を 許容 する。

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS prefecture TEXT;

COMMENT ON COLUMN public.organizations.prefecture IS
  '都道府県 (例: 「北海道」「東京都」)。 郵便番号 自動入力 の address1 に 相当';

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS prefecture TEXT;

COMMENT ON COLUMN public.signup_requests.prefecture IS
  '都道府県。 郵便番号 自動入力 の address1 相当';

NOTIFY pgrst, 'reload schema';

COMMIT;
