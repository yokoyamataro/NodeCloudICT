-- project_owners に フリガナ 列 を 追加。
-- 氏名 の 読み を 別 列 で 保持 する ため の もの。 名寄せ には 現状 使わない
-- (漢字氏名 + 住所 での 名寄せ を 優先) が、五十音 ソート や 検索 で 利用 する。

BEGIN;

ALTER TABLE public.project_owners
  ADD COLUMN IF NOT EXISTS name_kana TEXT;

CREATE INDEX IF NOT EXISTS idx_project_owners_name_kana
  ON public.project_owners(project_id, name_kana)
  WHERE name_kana IS NOT NULL;

COMMIT;
