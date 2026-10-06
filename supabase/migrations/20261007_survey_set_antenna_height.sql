-- 実測 の 記録セット (survey_record_sets) に アンテナ高 を 追加。
--
-- 従来 は 設定 メモ の 自由文 で 「アンテナ高 1.800」 と 書く 運用 だった が、
-- 観測手簿 の 整形 や 変換 (楕円体高 ↔ 標高) で 数値 として 使いたい ので
-- numeric カラム を 独立 して 持つ。
-- 単位 は m (メートル)。 ロッド 先端 〜 アンテナ 位相中心 までの 高さ。

BEGIN;

ALTER TABLE public.survey_record_sets
  ADD COLUMN IF NOT EXISTS antenna_height NUMERIC;

COMMENT ON COLUMN public.survey_record_sets.antenna_height IS
  '移動局 アンテナ 高 [m]。 ロッド 先端 〜 位相中心。 NULL は 未記録';

NOTIFY pgrst, 'reload schema';

COMMIT;
