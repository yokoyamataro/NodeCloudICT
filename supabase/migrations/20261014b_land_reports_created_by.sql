-- 調査報告書 (land_reports) の 作成者 を 記録 する。
-- 報告書番号 の 連番 を 「工区 単位」 から 「作成者 単位」 に 変更 する ため。
-- 旧 挙動 で は 工区 を 跨ぐ と 番号 が 1 から リセット して いた (毎回 YY00001)。
-- これ だ と 1 人 の 調査員 が 複数 工区 を 担当 する 現場 で 番号 が 重複 する。

ALTER TABLE public.land_reports
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_land_reports_created_by
  ON public.land_reports (created_by, created_at DESC);

NOTIFY pgrst, 'reload schema';
