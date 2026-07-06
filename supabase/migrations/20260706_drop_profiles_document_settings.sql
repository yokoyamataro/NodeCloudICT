-- profiles.document_settings の撤去。
--
-- 経緯:
--   立入通知書などの書類出力で「事務所情報」をここに保存していたが、
--   事務所情報は各 Word テンプレート (.docx) 本体に直書きする運用へ
--   変更したため、この列は不要になった。
--   参照していたアプリ側ストア (documentSettingsStore) と型 (DocumentSettings)
--   も同一コミットで削除している。
--
-- 実運用に残っている jsonb データは消える点に注意 (復元は各自の
-- テンプレート .docx に事務所情報を直書きすることで代替する)。

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS document_settings;
