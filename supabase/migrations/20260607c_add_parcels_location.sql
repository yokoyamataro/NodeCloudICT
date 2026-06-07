-- parcels に「所在」列を追加。住所・字名（例: A市B町一丁目）の表現用。
-- 地番一覧では「所在 → 地番(親番-小番)」の順でソートする想定。

ALTER TABLE public.parcels ADD COLUMN IF NOT EXISTS location text;
