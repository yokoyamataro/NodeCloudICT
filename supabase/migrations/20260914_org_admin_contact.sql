-- 組織情報 に 「読み仮名」 と 「管理者の 連絡先」 を 足す。
--
--   name_kana        … 組織名 の ひらがな。 並べ替え / 検索 用。
--                      「株式会社」 「土地家屋調査士」 等 の 肩書 は 省く 運用
--                      (入力欄 の 補足 で 案内 する)
--   admin_*          … 契約 の 窓口 に なる 管理者 の 連絡先。
--                      organizations.admin_user_id (アプリ上 の ユーザー) とは 別物 で、
--                      アカウント が 無くても 記録 できる ように テキスト で 持つ。

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS name_kana TEXT,
  ADD COLUMN IF NOT EXISTS admin_name TEXT,
  ADD COLUMN IF NOT EXISTS admin_department TEXT,
  ADD COLUMN IF NOT EXISTS admin_email TEXT,
  ADD COLUMN IF NOT EXISTS admin_phone TEXT;

COMMENT ON COLUMN public.organizations.name_kana IS
  '組織名 の ひらがな。 株式会社 / 土地家屋調査士 等 の 肩書 は 入れない';
COMMENT ON COLUMN public.organizations.admin_name IS
  '管理者 (契約窓口) の 氏名。 admin_user_id (アプリ上の ユーザー) とは 別';
COMMENT ON COLUMN public.organizations.admin_department IS '管理者 の 部署';
COMMENT ON COLUMN public.organizations.admin_email IS '管理者 の メールアドレス';
COMMENT ON COLUMN public.organizations.admin_phone IS '管理者 の 電話番号';
