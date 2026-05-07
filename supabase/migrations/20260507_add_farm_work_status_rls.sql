-- farm_work_status のメンバー方式 RLS ポリシーを追加
-- 既存の farm_id 系テーブル（design_work_areas など）と同じ運用方針に揃える。
-- 参照系: viewer 以上、書込系: editor 以上。

ALTER TABLE public.farm_work_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_work_status_select" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_insert" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_update" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_delete" ON public.farm_work_status;

CREATE POLICY "farm_work_status_select" ON public.farm_work_status FOR SELECT
  USING (public.is_farm_viewer(farm_id));

CREATE POLICY "farm_work_status_insert" ON public.farm_work_status FOR INSERT
  WITH CHECK (public.is_farm_editor(farm_id));

CREATE POLICY "farm_work_status_update" ON public.farm_work_status FOR UPDATE
  USING (public.is_farm_editor(farm_id));

CREATE POLICY "farm_work_status_delete" ON public.farm_work_status FOR DELETE
  USING (public.is_farm_editor(farm_id));
