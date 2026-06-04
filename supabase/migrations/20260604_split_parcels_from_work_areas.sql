-- 境界測量（地籍）の属性データを design_work_areas から分離する。
--
-- 背景:
--   design_work_areas は工種を問わず工事区域（ポリゴン）を保持する共通テーブル。
--   これに地番番号・所有者・地目などの地籍特有の列を足すと、
--   - 土木側のクエリにノイズが入る
--   - 個人情報を含む地籍情報が、土木プロジェクト用の権限でも見えてしまう
--   ので別テーブルへ切り出す。
--
-- 設計:
--   parcels(work_area_id FK UNIQUE, ...地籍属性...) というサイドカー方式。
--   ポリゴン形状（design_work_areas + point_ids）はそのまま共有する。
--   今回は移行用の最小限の列のみ（parcel_number / notes）を用意する。
--   今後、所有者・地目・登記簿面積などはここに ALTER TABLE で順次追加していく。
--
-- 既存データの扱い:
--   work_type = 'boundary_survey' の行に対して parcels 行を 1 つずつ作成し、
--   既存の design_work_areas.name → parcels.parcel_number
--   既存の design_work_areas.notes → parcels.notes
--   へ転記する。design_work_areas の name/notes は残したまま（既存 UI が読んでいる）。
--   UI を parcels 参照に切り替えるタイミングで段階的に移行する。
--
-- RLS:
--   とりあえず design_work_areas と同じ判定（farm 経由でメンバーシップ確認）で揃える。
--   個人情報項目（所有者氏名・住所など）が増えた段階で、viewer に見せない / 列単位で
--   隠す等の制御を追加する想定。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

-- ========================================================================
-- 1. parcels テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_area_id uuid NOT NULL UNIQUE
    REFERENCES public.design_work_areas(id) ON DELETE CASCADE,
  -- 移行で使う列（今後の地籍属性はここから ALTER TABLE で増やしていく）
  parcel_number text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parcels_work_area
  ON public.parcels (work_area_id);

-- updated_at 自動更新（touch_updated_at は profiles 移行で既に作成済み）
DROP TRIGGER IF EXISTS trg_parcels_touch ON public.parcels;
CREATE TRIGGER trg_parcels_touch
  BEFORE UPDATE ON public.parcels
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- 2. RLS（design_work_areas に揃える: 工区所属メンバー or 工事オーナー）
-- ========================================================================
ALTER TABLE public.parcels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parcels_select ON public.parcels;
DROP POLICY IF EXISTS parcels_insert ON public.parcels;
DROP POLICY IF EXISTS parcels_update ON public.parcels;
DROP POLICY IF EXISTS parcels_delete ON public.parcels;

CREATE POLICY parcels_select ON public.parcels FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.design_work_areas wa
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE wa.id = parcels.work_area_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY parcels_insert ON public.parcels FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.design_work_areas wa
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE wa.id = parcels.work_area_id
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

CREATE POLICY parcels_update ON public.parcels FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.design_work_areas wa
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE wa.id = parcels.work_area_id
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
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.design_work_areas wa
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE wa.id = parcels.work_area_id
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

CREATE POLICY parcels_delete ON public.parcels FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.design_work_areas wa
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE wa.id = parcels.work_area_id
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

-- ========================================================================
-- 3. 既存データの移行（境界測量の design_work_areas → parcels）
-- ========================================================================
-- 既に parcels に行があるものは ON CONFLICT で温存する。
INSERT INTO public.parcels (work_area_id, parcel_number, notes)
SELECT id, name, notes
FROM public.design_work_areas
WHERE work_type = 'boundary_survey'
ON CONFLICT (work_area_id) DO NOTHING;

-- ========================================================================
-- 4. 移行確認用クエリ（手動で実行して件数の一致を確認する）
-- ========================================================================
-- SELECT
--   (SELECT COUNT(*) FROM public.design_work_areas WHERE work_type = 'boundary_survey') AS source,
--   (SELECT COUNT(*) FROM public.parcels) AS migrated;
