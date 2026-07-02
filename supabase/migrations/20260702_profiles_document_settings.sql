-- profiles に document_settings jsonb を追加。
-- 立入通知書などの文書作成機能で使う「事務所情報」（住所・氏名・電話番号・
-- メールアドレス・担当者名 等）を per-user で保存する。
--
-- RLS: 既存の profiles ポリシー（本人 SELECT/UPDATE 可）で読み書きできる。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS document_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
