-- 実測 の 記録セット (survey_record_sets) に、GNSS 観測手簿 で 要る メタ を 追加。
--
--   antenna_name          … 移動局 アンテナ の 機種 / 番号 の 表記
--   receiver_name         … 移動局 受信機 の 機種 / 番号 の 表記
--   base_station_position … 基準局 の 位置情報 (例: 「X=..., Y=..., Z=...」
--                            or 「緯度 xx / 経度 yy」)。 自由文字列 で 記録
--
-- 既存 の base_station (基準局 名) と 併記 する 使い方 を 想定。
-- 1 観測 セット に 1 回 だけ 入力 する ため、staking_records 側 の カラム は
-- 増やさない。

BEGIN;

ALTER TABLE public.survey_record_sets
  ADD COLUMN IF NOT EXISTS antenna_name TEXT,
  ADD COLUMN IF NOT EXISTS receiver_name TEXT,
  ADD COLUMN IF NOT EXISTS base_station_position TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;
