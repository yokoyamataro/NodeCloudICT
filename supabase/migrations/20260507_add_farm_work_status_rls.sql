-- farm_work_status のメンバー方式 RLS ポリシーを追加
-- 既存の farm_id 系テーブル（design_work_areas など）と同じ運用方針に揃える
-- （20260425_member_based_rls_fix4.sql の方式: ヘルパー関数を使わず project_members をインライン参照）。
-- 参照系: プロジェクトメンバー（role 不問）, 書込系: owner/editor のみ。

ALTER TABLE public.farm_work_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_work_status_select" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_insert" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_update" ON public.farm_work_status;
DROP POLICY IF EXISTS "farm_work_status_delete" ON public.farm_work_status;

CREATE POLICY "farm_work_status_select" ON public.farm_work_status FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_work_status.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "farm_work_status_insert" ON public.farm_work_status FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_work_status.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY "farm_work_status_update" ON public.farm_work_status FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_work_status.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY "farm_work_status_delete" ON public.farm_work_status FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_work_status.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );
