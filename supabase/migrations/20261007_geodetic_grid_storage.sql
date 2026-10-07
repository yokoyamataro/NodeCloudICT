-- 測地座標変換 (TKY2JGD / PATCHJGD) の グリッド ファイル 格納用 bucket。
-- 国土地理院 の TKY2JGD.par (日本測地系 → 世界測地系) と
-- 地震毎 の 地殻変動補正 patch (熊本2016 / 東北2011 / 能登2024 / 青森2025 等) を 置く。
--
-- 階層:
--   geodetic-grid/
--     tky2jgd/TKY2JGD.par                        -- 全国 共通 (約 10.8 MB)
--     patchjgd/<event-id>/<event-name>.par       -- 地震 毎
--
-- 公開 読み取り (ログイン 必要) で OK。 書き込み は 本来 管理者 のみ だが
-- authenticated 全員 に 一旦 開く (運用 が 増えた ら admin ロール で 絞る)。

INSERT INTO storage.buckets (id, name, public)
VALUES ('geodetic-grid', 'geodetic-grid', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "geodetic_grid_select" ON storage.objects;
DROP POLICY IF EXISTS "geodetic_grid_insert" ON storage.objects;
DROP POLICY IF EXISTS "geodetic_grid_update" ON storage.objects;
DROP POLICY IF EXISTS "geodetic_grid_delete" ON storage.objects;

CREATE POLICY "geodetic_grid_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'geodetic-grid');

CREATE POLICY "geodetic_grid_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'geodetic-grid');

CREATE POLICY "geodetic_grid_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'geodetic-grid')
  WITH CHECK (bucket_id = 'geodetic-grid');

CREATE POLICY "geodetic_grid_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'geodetic-grid');
