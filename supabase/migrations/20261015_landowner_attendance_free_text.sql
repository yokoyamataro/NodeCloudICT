-- 地権者 の 立会状況 を 自由記述 対応 に する。
--
-- 変更点:
--   1. CHECK 制約 を 外す (任意 の 文字列 を 受け付ける)
--   2. 既存 の enum ID を 日本語 ラベル に 書き換える
--      これ により 「立会確認省略」 の よう な 選択肢 を 追加 したり、
--      自由 文 を 入れたり しても DB 側 は 変更 不要 に なる
--   3. default を 'not_attended' から '未立会' に 変更
--
-- 新規 の 推奨 選択肢 (UI 側 で datalist で 示す):
--   未立会 / 現地立会確認済 / 書面確認済 / 立会確認省略 / 不承諾

BEGIN;

ALTER TABLE public.landowners
  DROP CONSTRAINT IF EXISTS landowners_attendance_status_check;

UPDATE public.landowners
SET attendance_status = CASE attendance_status
  WHEN 'not_attended'        THEN '未立会'
  WHEN 'field_confirmed'     THEN '現地立会確認済'
  WHEN 'document_confirmed'  THEN '書面確認済'
  WHEN 'rejected'            THEN '不承諾'
  ELSE attendance_status
END
WHERE attendance_status IN ('not_attended', 'field_confirmed', 'document_confirmed', 'rejected');

ALTER TABLE public.landowners
  ALTER COLUMN attendance_status SET DEFAULT '未立会';

NOTIFY pgrst, 'reload schema';

COMMIT;
