-- 杭種の表示名「プラ杭」→「プラスチック杭」への統一。
-- design_coordinates.stake_type は自由入力を許容する text 列なので、
-- 既存データも一括置換する。

UPDATE public.design_coordinates
SET stake_type = 'プラスチック杭'
WHERE stake_type = 'プラ杭';
