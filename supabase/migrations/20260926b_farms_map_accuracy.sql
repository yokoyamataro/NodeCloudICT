-- 工区 (farms) に 地図精度区分 の 設定 を 追加。
--
-- 不動産登記規則 別表 の 甲一〜乙三 を 値 として 持ち、
-- 地籍測量 の 公差計算 (landReportKoosa.ts) と 09 甲差検証 で 参照 する。
--
-- 値: 'a1' | 'a2' | 'a3' | 'b1' | 'b2' | 'b3' (未設定 は NULL)

BEGIN;

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS map_accuracy TEXT
  CHECK (map_accuracy IN ('a1', 'a2', 'a3', 'b1', 'b2', 'b3'));

NOTIFY pgrst, 'reload schema';

COMMIT;
