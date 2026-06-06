-- 境界測量の design_work_areas（work_type='boundary_survey'）が INSERT された
-- ときに、対応する parcels 行が無ければ自動的に作る。
--
-- 背景:
--   SIMA 取り込みは design_work_areas には地番ラベル (name / zone_number) を
--   入れるが、parcels テーブルへの行追加は別途処理する必要があり、
--   何千件もの SIMA 取り込み後に「地番名が空に見える」状況が発生していた。
--   トリガで自動補完すれば、UI 側はいつでも parcels.parcel_number を参照
--   できる。
--
-- 既存の取り込み済みデータについては、最後に backfill INSERT を実行して
-- 親が無い design_work_areas に対応する parcels を一気に作る。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

CREATE OR REPLACE FUNCTION public.handle_new_boundary_work_area()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.work_type = 'boundary_survey' THEN
    INSERT INTO public.parcels (work_area_id, parcel_number, notes)
    VALUES (NEW.id, NEW.name, NEW.notes)
    ON CONFLICT (work_area_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_design_work_areas_insert_parcel ON public.design_work_areas;
CREATE TRIGGER on_design_work_areas_insert_parcel
  AFTER INSERT ON public.design_work_areas
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_boundary_work_area();

-- 既存データ backfill: 親 design_work_areas に対応する parcels が無いものを補完
INSERT INTO public.parcels (work_area_id, parcel_number, notes)
SELECT wa.id, wa.name, wa.notes
FROM public.design_work_areas wa
WHERE wa.work_type = 'boundary_survey'
  AND NOT EXISTS (
    SELECT 1 FROM public.parcels p WHERE p.work_area_id = wa.id
  );
