-- 地積測量図 (land_survey_drawings)。
--
-- doc/地積測量図3.tif が 実物。 B4 1 枚 に 左 が 計算書 (与点 の 成果 と
-- 求積表)、右 が 図。 建物図面 と 同じ く 1 工区 に 複数枚 作る。
--
-- 作成 の 手順 が そのまま 列 の 区分 に なって いる:
--   1. 作製者 / 申請人      → frame (jsonb。 建物図面 と 同じ 形)
--   2. 対象 と なる 地番     → spec.parcelIds
--   3. 使用 した 基準点      → spec.controlPointIds
--   4. 図枠 と 縮尺          → scale_denominator / frame.overlay
--
-- spec は 図面 の 中身 が これから 増える ので jsonb で 持つ。
--   { parcelIds, controlPointIds, mapNumber, markers, surveyedOn, zone,
--     datumNote, remarks }

CREATE TABLE IF NOT EXISTS public.land_survey_drawings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  -- 一覧 の 見出し。 空 なら 地番 で 代用 する
  title text,
  -- 用紙 上部 に 出す 土地 の 所在
  location text,
  -- 2〜3 の 中身
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 作製者 / 申請人 / 図枠 の 手直し (建物図面 と 同じ 形)
  frame jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 1/500 が 既定。 1/1000 / 1/2500 / 任意 も 選べる
  scale_denominator integer NOT NULL DEFAULT 500,
  -- 1 申請 が 複数枚 に なる ときの 枚数
  sheet_no integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_land_survey_drawings_farm
  ON public.land_survey_drawings (farm_id);

DROP TRIGGER IF EXISTS trg_land_survey_drawings_touch ON public.land_survey_drawings;
CREATE TRIGGER trg_land_survey_drawings_touch
  BEFORE UPDATE ON public.land_survey_drawings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- RLS: 他の 境界測量系 と 同じ (工区メンバー は 閲覧、編集 は owner/editor)
-- ========================================================================
ALTER TABLE public.land_survey_drawings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS land_survey_drawings_select ON public.land_survey_drawings;
DROP POLICY IF EXISTS land_survey_drawings_insert ON public.land_survey_drawings;
DROP POLICY IF EXISTS land_survey_drawings_update ON public.land_survey_drawings;
DROP POLICY IF EXISTS land_survey_drawings_delete ON public.land_survey_drawings;

CREATE POLICY land_survey_drawings_select ON public.land_survey_drawings FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_survey_drawings.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY land_survey_drawings_insert ON public.land_survey_drawings FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_survey_drawings.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY land_survey_drawings_update ON public.land_survey_drawings FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_survey_drawings.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_survey_drawings.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY land_survey_drawings_delete ON public.land_survey_drawings FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_survey_drawings.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

-- PostgREST の スキーマキャッシュ を 更新 する
NOTIFY pgrst, 'reload schema';
