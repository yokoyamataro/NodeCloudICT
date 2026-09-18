-- 実測 の 記録セット (survey_record_sets)。
--
-- 実測 は 日 や 担当者 が 変われば 使う 基準局 も 設定 も 変わる ので、
-- スライド量 を 工区 に 1 つ だけ 持つ のは 無理 が ある。 記録 を セット に
-- 束ね、スライド量 は セット ごと に 持つ。
--
-- 同じ 日 / 同じ 人 でも セット を 分けられる (基準局 を 変えた、設定 を
-- 変えた など)。 既に 取った 記録 も 点 ごと に 別 の セット へ 移せる。
--
-- 既存 の 工区 単位 の スライド量 (design_survey_calibration) は そのまま
-- 残す。 「既定 の セット」 の 値 と して 引き継ぐ ので、これまで の 画面 も
-- 動き続ける。

CREATE TABLE IF NOT EXISTS public.survey_record_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  -- 表示名。 空 なら 測量日 と 担当者 から 組み立てる
  name text,
  -- 測量日 / 担当者 / 使用 した 基準局 / 設定 の メモ
  measured_on date,
  operator text,
  base_station text,
  settings_note text,
  -- スライド量 (実測 に かける 定数オフセット)
  dx_offset numeric NOT NULL DEFAULT 0,
  dy_offset numeric NOT NULL DEFAULT 0,
  dz_offset numeric NOT NULL DEFAULT 0,
  -- 新しい 記録 を 入れる 先。 工区 に 1 つ だけ true
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_record_sets_farm
  ON public.survey_record_sets (farm_id);
-- 既定 は 工区 に 1 つ
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_record_sets_default
  ON public.survey_record_sets (farm_id) WHERE is_default;

DROP TRIGGER IF EXISTS trg_survey_record_sets_touch ON public.survey_record_sets;
CREATE TRIGGER trg_survey_record_sets_touch
  BEFORE UPDATE ON public.survey_record_sets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---- 記録 に セット を 持たせる ----
ALTER TABLE public.staking_records
  ADD COLUMN IF NOT EXISTS record_set_id uuid
    REFERENCES public.survey_record_sets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staking_records_set
  ON public.staking_records (record_set_id);

-- ---- 既存 の 記録 を 「既定 の セット」 に 寄せる ----
-- 工区 ごと に 1 つ 作り、工区 単位 の スライド量 を 引き継ぐ。
INSERT INTO public.survey_record_sets
  (farm_id, name, dx_offset, dy_offset, dz_offset, is_default, sort_order)
SELECT
  f.id,
  '既存の記録',
  COALESCE(c.dx_offset, 0),
  COALESCE(c.dy_offset, 0),
  COALESCE(c.dz_offset, 0),
  true,
  0
FROM public.farms f
LEFT JOIN public.design_survey_calibration c ON c.farm_id = f.id
WHERE EXISTS (SELECT 1 FROM public.staking_records r WHERE r.farm_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM public.survey_record_sets s WHERE s.farm_id = f.id)
ON CONFLICT DO NOTHING;

UPDATE public.staking_records r
   SET record_set_id = s.id
  FROM public.survey_record_sets s
 WHERE s.farm_id = r.farm_id
   AND s.is_default
   AND r.record_set_id IS NULL;

-- ---- 新しい 記録 は 「既定 の セット」 に 入れる ----
-- 測る 側 (iOS / スマホ) は セット を 知らない ので、DB 側 で 埋める。
-- こう して おけば オフライン 退避 分 の 後送り でも 同じ 扱い に なる。
CREATE OR REPLACE FUNCTION public.staking_records_fill_default_set()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.record_set_id IS NULL THEN
    SELECT s.id INTO NEW.record_set_id
      FROM public.survey_record_sets s
     WHERE s.farm_id = NEW.farm_id AND s.is_default
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staking_records_default_set ON public.staking_records;
CREATE TRIGGER trg_staking_records_default_set
  BEFORE INSERT ON public.staking_records
  FOR EACH ROW EXECUTE FUNCTION public.staking_records_fill_default_set();

-- ========================================================================
-- RLS: staking_records と 同じ 考え (工区 に 入れる 人 が 触れる)
-- ========================================================================
ALTER TABLE public.survey_record_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS survey_record_sets_select ON public.survey_record_sets;
DROP POLICY IF EXISTS survey_record_sets_insert ON public.survey_record_sets;
DROP POLICY IF EXISTS survey_record_sets_update ON public.survey_record_sets;
DROP POLICY IF EXISTS survey_record_sets_delete ON public.survey_record_sets;

CREATE POLICY survey_record_sets_select ON public.survey_record_sets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = survey_record_sets.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY survey_record_sets_insert ON public.survey_record_sets FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = survey_record_sets.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY survey_record_sets_update ON public.survey_record_sets FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = survey_record_sets.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = survey_record_sets.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY survey_record_sets_delete ON public.survey_record_sets FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = survey_record_sets.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

NOTIFY pgrst, 'reload schema';
