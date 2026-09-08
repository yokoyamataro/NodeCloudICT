-- 工区の 閲覧履歴。工区設定の 「最終閲覧日 / 閲覧者」に 使う。
--
-- 1 工区 × 1 ユーザー で 1 行。開く たび に viewed_at を 更新する (upsert)。
-- 履歴を 積むと 際限なく 増える ので、最後に 見た 時刻だけ 残す。
--
-- Supabase SQL Editor で実行してください。

CREATE TABLE IF NOT EXISTS public.farm_views (
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_farm_views_farm_time
  ON public.farm_views(farm_id, viewed_at DESC);

ALTER TABLE public.farm_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_views_select" ON public.farm_views;
DROP POLICY IF EXISTS "farm_views_upsert" ON public.farm_views;
DROP POLICY IF EXISTS "farm_views_update" ON public.farm_views;

-- 工区メンバーなら 誰が いつ 見たか を 読める
CREATE POLICY "farm_views_select" ON public.farm_views
  FOR SELECT TO authenticated
  USING (public.is_farm_viewer(farm_id));

-- 書けるのは 自分の 行だけ
CREATE POLICY "farm_views_upsert" ON public.farm_views
  FOR INSERT TO authenticated
  WITH CHECK (public.is_farm_viewer(farm_id) AND user_id = auth.uid());
CREATE POLICY "farm_views_update" ON public.farm_views
  FOR UPDATE TO authenticated
  USING (public.is_farm_viewer(farm_id) AND user_id = auth.uid());
