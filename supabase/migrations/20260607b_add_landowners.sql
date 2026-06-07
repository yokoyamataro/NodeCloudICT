-- 地権者管理機能。
--
-- landowners        : 地権者本体（工区単位）。氏名・連絡先・代理人・立会情報を保持
-- parcel_landowners : 地番（parcels）と地権者の多対多関連。共有名義の表現に使う
--
-- 既存 parcels.owner_name / owner_address / attended_at は地番管理画面では
-- 分離するため:
--   ・owner_name    → registered_owner_name にリネーム（登記簿上の所有者）
--   ・owner_address → registered_owner_address にリネーム
--   ・attended_at   は廃止（立会日時は landowners 側に移行）
--
-- RLS は他の境界測量系テーブルと同じ「工区メンバーが SELECT 可、編集は
-- owner/editor のみ」の方針に揃える。

-- ========================================================================
-- 0. parcels の列リネーム + 列削除
-- ========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'parcels' AND column_name = 'owner_name'
  ) THEN
    ALTER TABLE public.parcels RENAME COLUMN owner_name TO registered_owner_name;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'parcels' AND column_name = 'owner_address'
  ) THEN
    ALTER TABLE public.parcels RENAME COLUMN owner_address TO registered_owner_address;
  END IF;
END $$;

ALTER TABLE public.parcels DROP COLUMN IF EXISTS attended_at;

-- ========================================================================
-- 1. landowners テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.landowners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  postal_code text,
  address text,
  phone text,
  agent_name text,
  agent_address text,
  agent_phone text,
  agent_relation text,
  primary_attendance_at timestamptz,
  secondary_attendance_at timestamptz,
  notification_method text,
  attendance_status text NOT NULL DEFAULT 'not_attended',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.landowners
  DROP CONSTRAINT IF EXISTS landowners_notification_method_check;
ALTER TABLE public.landowners
  ADD CONSTRAINT landowners_notification_method_check
  CHECK (
    notification_method IS NULL
    OR notification_method IN ('direct_visit', 'mail', 'phone', 'agent')
  );

ALTER TABLE public.landowners
  DROP CONSTRAINT IF EXISTS landowners_attendance_status_check;
ALTER TABLE public.landowners
  ADD CONSTRAINT landowners_attendance_status_check
  CHECK (
    attendance_status IN ('not_attended', 'field_confirmed', 'document_confirmed', 'rejected')
  );

CREATE INDEX IF NOT EXISTS idx_landowners_farm ON public.landowners (farm_id);

DROP TRIGGER IF EXISTS trg_landowners_touch ON public.landowners;
CREATE TRIGGER trg_landowners_touch
  BEFORE UPDATE ON public.landowners
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.landowners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landowners_select ON public.landowners;
DROP POLICY IF EXISTS landowners_insert ON public.landowners;
DROP POLICY IF EXISTS landowners_update ON public.landowners;
DROP POLICY IF EXISTS landowners_delete ON public.landowners;

CREATE POLICY landowners_select ON public.landowners FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = landowners.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY landowners_insert ON public.landowners FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = landowners.farm_id
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

CREATE POLICY landowners_update ON public.landowners FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = landowners.farm_id
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
      WHERE f.id = landowners.farm_id
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

CREATE POLICY landowners_delete ON public.landowners FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = landowners.farm_id
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

-- ========================================================================
-- 2. parcel_landowners 多対多関連テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.parcel_landowners (
  parcel_id uuid NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  landowner_id uuid NOT NULL REFERENCES public.landowners(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parcel_id, landowner_id)
);

CREATE INDEX IF NOT EXISTS idx_parcel_landowners_parcel ON public.parcel_landowners (parcel_id);
CREATE INDEX IF NOT EXISTS idx_parcel_landowners_landowner ON public.parcel_landowners (landowner_id);

ALTER TABLE public.parcel_landowners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parcel_landowners_select ON public.parcel_landowners;
DROP POLICY IF EXISTS parcel_landowners_insert ON public.parcel_landowners;
DROP POLICY IF EXISTS parcel_landowners_delete ON public.parcel_landowners;

CREATE POLICY parcel_landowners_select ON public.parcel_landowners FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.parcels p
      JOIN public.design_work_areas wa ON wa.id = p.work_area_id
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE p.id = parcel_landowners.parcel_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id AND pm.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY parcel_landowners_insert ON public.parcel_landowners FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.parcels p
      JOIN public.design_work_areas wa ON wa.id = p.work_area_id
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE p.id = parcel_landowners.parcel_id
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

CREATE POLICY parcel_landowners_delete ON public.parcel_landowners FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.parcels p
      JOIN public.design_work_areas wa ON wa.id = p.work_area_id
      JOIN public.farms f ON f.id = wa.farm_id
      WHERE p.id = parcel_landowners.parcel_id
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
