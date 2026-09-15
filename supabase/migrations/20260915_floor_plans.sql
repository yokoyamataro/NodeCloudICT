-- 建物図面・各階平面図 (floor_plans)。
--
-- 登記 に 出す B4 1 枚 の 用紙 に 「各階平面図 (左)」 と 「建物図面 (右)」 が
-- 同居 する 様式。 doc/tatemono1.tif が 実物。 1 申請 で 収まらない 分 は
-- 2 枚目 に 送る (sheet_no) ので、工区 に 複数行 ぶら下がる。
--
-- 作成 の 手順 が そのまま 列 の 区分 に なって いる:
--   1. 建物 の 所在 / 地番 / 家屋番号   → location / parcel_number / house_number
--   2. 階層 と 形状寸法 + 求積表         → figures  (jsonb)
--   3. 地番 に対する 配置 (建物図面)     → site     (jsonb)
--   4. 図枠要素 (表題欄)                 → frame    (jsonb)
--
-- 2〜4 を jsonb に して いる のは 図面 の 中身 が これから 増える ため。
-- 列 を 足す たび に 移行 を 書く より 形 が 固まる まで は jsonb で 持つ。
-- 検索 も 集計 も しない 領域 な ので 不都合 は ない。
--
-- figures : [{ id, kind:'main'|'annex', annexNo, floorNo, outline:[{x,y}],
--              offset:{x,y}, terms:[{id,kind,a,b,h,manual,note}] }]
--           outline は m 単位 の 多角形 (x=東 / y=北)。 隅切り が ある ので
--           矩形 の 和 では 表せない。 terms は 求積表 の 各行。
-- site    : { parcelPointIds, offsetE, offsetN, rotationDeg, northAngleDeg,
--             neighbors:[{id,label,x,y}], refDistances:[{id,label,value}] }
-- frame   : { createdOn, makerAddress, makerQualification, makerName,
--             applicantName, remarks }

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
  -- 2. 階層 と 形状寸法 + 求積表
  figures jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 3. 地番 に対する 配置 (用紙 右半分 の 建物図面)
  site jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 4. 図枠要素 (表題欄)
  frame jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 縮尺 は 左右 で 別。 各階平面図 1/250 / 建物図面 1/500 が 原則
  plan_scale integer NOT NULL DEFAULT 250,
  site_scale integer NOT NULL DEFAULT 500,
  -- 1 申請 が 複数枚 に なる ときの 枚数 (1 始まり)
  sheet_no integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 先 に 旧版 (floors / placement / scale_denominator) を 作って いた 場合 の 手当て。
-- CREATE TABLE IF NOT EXISTS は 列 を 足して くれない ので ここ で 揃える。
ALTER TABLE public.floor_plans
  ADD COLUMN IF NOT EXISTS figures jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS site jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS plan_scale integer NOT NULL DEFAULT 250,
  ADD COLUMN IF NOT EXISTS site_scale integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS sheet_no integer NOT NULL DEFAULT 1;

ALTER TABLE public.floor_plans
  DROP COLUMN IF EXISTS floors,
  DROP COLUMN IF EXISTS placement,
  DROP COLUMN IF EXISTS scale_denominator;

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

-- PostgREST の スキーマキャッシュ を 更新 する。 これ が 無い と 列 を 足した 直後 に
-- PGRST204 (Could not find the '…' column in the schema cache) が 出る。
NOTIFY pgrst, 'reload schema';
