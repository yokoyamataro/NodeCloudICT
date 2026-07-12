-- 巨大市 (天草・唐津・岩国・高松・佐渡・一関・東広島など) の gzip 済み GeoJSON が
-- Supabase Storage のバケット default file_size_limit (50 MB) を超えるため、
-- Pro プランの許容範囲内 (5 GB/file) で余裕を持って 1 GB に引き上げる。
--
-- サイズ試算: 東広島市 raw ~600 MB → gzip level 9 で ~50〜100 MB。
-- 全国最大 (東京都区部などが将来出てきても) 1 GB あれば当分は問題ない想定。

UPDATE storage.buckets
SET file_size_limit = 1073741824  -- 1 GiB (1024^3 bytes)
WHERE id = 'parcel-maps';
