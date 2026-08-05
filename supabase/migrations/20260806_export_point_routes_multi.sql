-- ============================================================
-- export_point_routes を複数ルート対応に:
--   - 従来: 1 farm = 1 route (UNIQUE(farm_id))
--   - 変更後: 1 farm = 複数 routes (UNIQUE(farm_id, name))
-- name カラムを追加し、既存行には '既定' をデフォルト付与。
-- ============================================================

ALTER TABLE public.export_point_routes
  ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '既定';

-- 旧 UNIQUE(farm_id) 制約を落とす。CREATE TABLE 側の UNIQUE 指定でも
-- UNIQUE 制約が作られているため、名前が「export_point_routes_farm_id_key」
-- で存在する場合を想定してドロップ。存在しなくてもエラーにしない。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'export_point_routes_farm_id_key'
  ) THEN
    ALTER TABLE public.export_point_routes
      DROP CONSTRAINT export_point_routes_farm_id_key;
  END IF;
END $$;

-- 新 UNIQUE(farm_id, name)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'export_point_routes'
      AND indexname = 'export_point_routes_farm_id_name_key'
  ) THEN
    CREATE UNIQUE INDEX export_point_routes_farm_id_name_key
      ON public.export_point_routes(farm_id, name);
  END IF;
END $$;
