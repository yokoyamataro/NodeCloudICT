-- 建物調査報告書 (building_reports) テーブル。
--
-- 土地調査報告書 (land_reports) と 同構造 で、 body を jsonb で 保持 する。
-- 用途 は 建物 の 表題登記 / 滅失登記 / 分割 / 合併 等 の 調査報告。
-- 様式 は 「様式第10-1号」 (普通建物) に 準拠。
--
-- RLS は land_reports と 同じ (「工区 に アクセス できる プロジェクト メンバー」) だが、
-- Supabase SQL エディタ で ネスト 深い EXISTS を 貼る と パーサ が 詰まる こと が ある ので
-- 政策式 を フラット に (farm_id を 1 回 の IN サブクエリ で 絞る) 書き直して いる。

BEGIN;

CREATE TABLE IF NOT EXISTS public.building_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id     uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '無題の建物調査報告書',
  body        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_building_reports_farm
  ON public.building_reports (farm_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_building_reports_user_num
  ON public.building_reports (created_by, created_at DESC);

DROP TRIGGER IF EXISTS trg_building_reports_touch ON public.building_reports;
CREATE TRIGGER trg_building_reports_touch
  BEFORE UPDATE ON public.building_reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.building_reports ENABLE ROW LEVEL SECURITY;

-- アクセス できる farm_id を 返す ヘルパ (UNION で 自分 の 工区 と メンバー 工区)
CREATE OR REPLACE FUNCTION public._my_accessible_farm_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.farms WHERE user_id = auth.uid()
  UNION
  SELECT f.id FROM public.farms f
  JOIN public.project_members pm ON pm.project_id = f.project_id
  WHERE pm.user_id = auth.uid()
$$;

DROP POLICY IF EXISTS "building_reports_all" ON public.building_reports;
CREATE POLICY "building_reports_all" ON public.building_reports
  FOR ALL TO authenticated
  USING (farm_id IN (SELECT public._my_accessible_farm_ids()))
  WITH CHECK (farm_id IN (SELECT public._my_accessible_farm_ids()));

COMMENT ON TABLE public.building_reports IS
  '建物調査報告書 (様式第10-1号 普通建物)。1 工区 N 報告書。body は 全入力を jsonb で保持';

NOTIFY pgrst, 'reload schema';

COMMIT;
