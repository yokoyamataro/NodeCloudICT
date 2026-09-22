-- registry_properties (物件) に 工区 (farm) の 割当 列 を 追加。
-- 手動 割当 方式: NULL = 未割当。 farm 削除時 は 割当 だけ 外す (NULL に 戻す)。

BEGIN;

ALTER TABLE public.registry_properties
  ADD COLUMN IF NOT EXISTS farm_id UUID
  REFERENCES public.farms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_registry_properties_farm
  ON public.registry_properties(farm_id)
  WHERE farm_id IS NOT NULL;

COMMIT;
