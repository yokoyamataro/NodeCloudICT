-- 地番 の 閲覧履歴。 地番一覧 の 「表示履歴」 列 に 使う。
--
-- design_work_areas (地番の 器) × ユーザー で 1 行 だけ。 開く たび に
-- viewed_at を 更新 (upsert)。 履歴 を 積むと 際限なく 増える ので、
-- 最後 に 見た 時刻 だけ 残す。 farm_views と 同じ 方式。

CREATE TABLE IF NOT EXISTS public.parcel_views (
  work_area_id UUID NOT NULL REFERENCES public.design_work_areas(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (work_area_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_parcel_views_work_area_time
  ON public.parcel_views(work_area_id, viewed_at DESC);

ALTER TABLE public.parcel_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parcel_views_select" ON public.parcel_views;
DROP POLICY IF EXISTS "parcel_views_upsert" ON public.parcel_views;
DROP POLICY IF EXISTS "parcel_views_update" ON public.parcel_views;

-- 工区 メンバー なら 誰 が いつ 見た か を 読める
-- (design_work_areas を 通じて farm_id を 辿り、is_farm_viewer で 判定)
CREATE POLICY "parcel_views_select" ON public.parcel_views
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.design_work_areas w
      WHERE w.id = parcel_views.work_area_id
        AND public.is_farm_viewer(w.farm_id)
    )
  );

CREATE POLICY "parcel_views_upsert" ON public.parcel_views
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.design_work_areas w
      WHERE w.id = parcel_views.work_area_id
        AND public.is_farm_viewer(w.farm_id)
    )
  );

CREATE POLICY "parcel_views_update" ON public.parcel_views
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.design_work_areas w
      WHERE w.id = parcel_views.work_area_id
        AND public.is_farm_viewer(w.farm_id)
    )
  );

NOTIFY pgrst, 'reload schema';
