-- 20260712 のマイグレーションで作成した部分ユニークインデックスは
-- ON CONFLICT 節で使えないため、WHERE 節なしのフル UNIQUE index に置き換える。
--
-- PG のユニーク制約 では NULL は「distinct」扱いなので、
-- (registry_code, registry_sub) 両方 NULL の既存レコードは複数存在してよい。

DROP INDEX IF EXISTS public.ux_parcel_map_datasets_registry;

CREATE UNIQUE INDEX IF NOT EXISTS ux_parcel_map_datasets_registry
  ON public.parcel_map_datasets (registry_code, registry_sub);
