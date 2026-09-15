-- 各階平面図 (floor_plans)。
--
-- 建物表題登記 に 添える B4 の 図面。 1 工区 に 複数枚 作る ので 工区単位 の
-- 独立した 行 に する (地番 parcels とは 任意 の 紐づけ)。
--
-- 作成 の 手順 が そのまま 列 の 区分 に なって いる:
--   1. 建物 の 所在 / 地番 / 家屋番号   → location / parcel_number / house_number
--   2. 階層 と 形状寸法 (縦横)          → floors   (jsonb)
--   3. 地番 に対する 配置               → placement (jsonb)
--   4. 図枠要素                         → frame    (jsonb)
--
-- 2〜4 を jsonb に して いる のは、図面 の 中身 が これから 増える ため。
-- 列 を 足す たび に 移行 を 書く より、形 が 固まる まで は jsonb で 持つ。
-- 検索 も 集計 も しない 領域 な ので 不都合 は ない。
--
-- floors   : [{ id, name, rects: [{x,y,w,h}], areaSqm, areaOverride }]
--            rects は m 単位。 x=東 / y=北 の 相対位置、w=横 / h=縦。
--            L 字 など は 矩形 を 足して 表す。
-- placement: { parcelPointIds, offsetE, offsetN, rotationDeg, refDistances:[{label,value}] }
-- frame    : { sheetSize, createdOn, applicantName, surveyorName, surveyorOffice,
--              northAngleDeg, drawingNumber, remarks }

CREATE TABLE IF NOT EXISTS public.floor_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  -- 一覧 の 見出し。 空 なら 家屋番号 で 代用 する
  title text,
  -- 1. 建物 の 所在
  location text,
  parcel_number text,
  house_number text,
  building_kind text,       -- 種類 (居宅 / 共同住宅 など)
  building_structure text,  -- 構造 (木造かわらぶき2階建 など)
  -- 地番管理 の 行 と 結びつける (消えても 図面 は 残す)
  parcel_id uuid REFERENCES public.parcels(id) ON DELETE SET NULL,
  -- 2. 階層 と 形状寸法
  floors jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 3. 地番 に対する 配置
  placement jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 4. 図枠要素
  frame jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 各階平面図 は 1/250 が 原則
  scale_denominator integer NOT NULL DEFAULT 250,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_floor_plans_farm ON public.floor_plans (farm_id);

DROP TRIGGER IF EXISTS trg_floor_plans_touch ON public.floor_plans;
CREATE TRIGGER trg_floor_plans_touch
  BEFORE UPDATE ON public.floor_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- RLS: 他の 境界測量系 と 同じ (工区メンバー は 閲覧、編集 は owner/editor)
-- ========================================================================
ALTER TABLE public.floor_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS floor_plans_select ON public.floor_plans;
DROP POLICY IF EXISTS floor_plans_insert ON public.floor_plans;
DROP POLICY IF EXISTS floor_plans_update ON public.floor_plans;
DROP POLICY IF EXISTS floor_plans_delete ON public.floor_plans;

CREATE POLICY floor_plans_select ON public.floor_plans FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = floor_plans.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY floor_plans_insert ON public.floor_plans FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = floor_plans.farm_id
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

CREATE POLICY floor_plans_update ON public.floor_plans FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = floor_plans.farm_id
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
      WHERE f.id = floor_plans.farm_id
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

CREATE POLICY floor_plans_delete ON public.floor_plans FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = floor_plans.farm_id
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
