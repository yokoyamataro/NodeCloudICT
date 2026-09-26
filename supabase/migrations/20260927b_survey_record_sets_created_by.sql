-- 実測 の 記録セット (survey_record_sets) に 作成 アカウント を 持たせる。
--
-- 初回 測定 時 の セッション 自動判定 (同一日 / 同一 基準局 / 同一 アカウント なら
-- 直前 セッション に 追記) で 使う。
-- 既存 行 は 誰 の セッション か 分からない ので NULL の まま。
-- 新規 行 は DEFAULT auth.uid() で 埋める (INSERT で client が 埋め なく て も OK)。

BEGIN;

ALTER TABLE public.survey_record_sets
  ADD COLUMN IF NOT EXISTS created_by UUID
    REFERENCES auth.users(id) ON DELETE SET NULL
    DEFAULT auth.uid();

CREATE INDEX IF NOT EXISTS idx_survey_record_sets_created_by
  ON public.survey_record_sets (created_by);

NOTIFY pgrst, 'reload schema';

COMMIT;
