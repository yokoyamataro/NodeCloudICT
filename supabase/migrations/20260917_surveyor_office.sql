-- 土地家屋調査士 に 事務所 の 住所 と 法人 の 情報 を 足す。
--
-- 図面 の 表題欄 や 報告書 に は 事務所 の 住所 が 要る。 また 土地家屋
-- 調査士法人 の 場合 は 法人 の 名称 と、その 人 が 社員 か 代表社員 か を
-- 書く 必要 が ある。 個人 の 事務所 なら 法人名 は 空 の まま に する。

ALTER TABLE public.organization_surveyors
  ADD COLUMN IF NOT EXISTS office_address   text,  -- 事務所 の 住所
  ADD COLUMN IF NOT EXISTS corporation_name text,  -- 土地家屋調査士法人 の 名称
  -- 法人 の 場合 の 立場。 'member' = 社員 / 'representative' = 代表社員
  ADD COLUMN IF NOT EXISTS corporation_role text;

ALTER TABLE public.organization_surveyors
  DROP CONSTRAINT IF EXISTS organization_surveyors_corporation_role_check;
ALTER TABLE public.organization_surveyors
  ADD CONSTRAINT organization_surveyors_corporation_role_check
  CHECK (corporation_role IS NULL OR corporation_role IN ('member', 'representative'));

-- PostgREST の スキーマキャッシュ を 更新 する
NOTIFY pgrst, 'reload schema';
