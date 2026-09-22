-- 法務局備付地図作成作業 の 独立系 (registry_*) を 廃止 し、
-- 既存 の 境界測量 (parcels / landowners / parcel_landowners) に 統合。
--
-- 前提: 1 現場 = 1 farm。 project 単位 で 分離 する 必要 なし。
-- 履歴系 (所在/表示/甲区/乙区/所有権) は parcels の 子 テーブル として 追加。
-- 立会 情報 は parcel_landowners (parcel × landowner) に 移動。

BEGIN;

-- ============================================
-- 1. 削除: registry_* / project_owners / property_owner_shares
-- ============================================

DROP TABLE IF EXISTS public.property_owner_shares CASCADE;
DROP TABLE IF EXISTS public.project_owners CASCADE;
DROP TABLE IF EXISTS public.registry_otoku CASCADE;
DROP TABLE IF EXISTS public.registry_kouku CASCADE;
DROP TABLE IF EXISTS public.registry_ownerships CASCADE;
DROP TABLE IF EXISTS public.registry_display_histories CASCADE;
DROP TABLE IF EXISTS public.registry_locations CASCADE;
DROP TABLE IF EXISTS public.registry_properties CASCADE;

DROP FUNCTION IF EXISTS public.fn_registry_child_can_view(uuid);
DROP FUNCTION IF EXISTS public.fn_registry_child_can_edit(uuid);

-- ============================================
-- 2. parcels 拡張 (登記情報 と 合筆/分筆)
-- ============================================
-- registered_land_category / registered_area_sqm = 登記 時 の 値 (当初)
-- updated_land_category   / updated_area_sqm    = 確定 (現地測量後)
-- initial_* は 概念上 registered_* と 一致 する ので 新設 しない。

ALTER TABLE public.parcels
  ADD COLUMN IF NOT EXISTS registration_kind TEXT NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS registry_seq INTEGER,
  ADD COLUMN IF NOT EXISTS registry_kind TEXT,          -- 物件種別 土地 / 建物
  ADD COLUMN IF NOT EXISTS registry_status TEXT,        -- 既存 / 登記済 等
  ADD COLUMN IF NOT EXISTS real_estate_number TEXT,     -- 不動産番号
  ADD COLUMN IF NOT EXISTS merged_area_sqm NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS merged_into_parcel_id UUID
    REFERENCES public.parcels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at DATE,
  ADD COLUMN IF NOT EXISTS split_from_parcel_id UUID
    REFERENCES public.parcels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_at DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parcels_registration_kind_chk'
  ) THEN
    ALTER TABLE public.parcels
      ADD CONSTRAINT parcels_registration_kind_chk
      CHECK (registration_kind IN ('registered', 'provisional', 'confirmed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_parcels_registration_kind
  ON public.parcels(registration_kind);
CREATE INDEX IF NOT EXISTS idx_parcels_merged_into
  ON public.parcels(merged_into_parcel_id)
  WHERE merged_into_parcel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parcels_split_from
  ON public.parcels(split_from_parcel_id)
  WHERE split_from_parcel_id IS NOT NULL;

-- ============================================
-- 3. landowners 拡張 (フリガナ、phone/agent_* は 既存)
-- ============================================

ALTER TABLE public.landowners
  ADD COLUMN IF NOT EXISTS name_kana TEXT;

CREATE INDEX IF NOT EXISTS idx_landowners_name_kana
  ON public.landowners(farm_id, name_kana)
  WHERE name_kana IS NOT NULL;

-- ============================================
-- 4. parcel_landowners 拡張 (立会 per parcel × landowner + 持分)
-- ============================================

ALTER TABLE public.parcel_landowners
  ADD COLUMN IF NOT EXISTS share TEXT,
  ADD COLUMN IF NOT EXISTS first_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_visit_status TEXT,
  ADD COLUMN IF NOT EXISTS second_visit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_visit_status TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- ============================================
-- 5. CSV 履歴 テーブル (parcels の 子)
-- ============================================

CREATE TABLE IF NOT EXISTS public.parcel_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  change_reason TEXT,
  registered_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parcel_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_parcel_locations_parcel
  ON public.parcel_locations(parcel_id);

CREATE TABLE IF NOT EXISTS public.parcel_display_histories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  parcel_number TEXT NOT NULL DEFAULT '',
  land_category TEXT NOT NULL DEFAULT '',
  area_text TEXT NOT NULL DEFAULT '',
  reason TEXT,
  cause_date TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parcel_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_parcel_display_histories_parcel
  ON public.parcel_display_histories(parcel_id);

CREATE TABLE IF NOT EXISTS public.parcel_ownerships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  share TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  extra TEXT,
  received_at TEXT,
  receipt_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parcel_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_parcel_ownerships_parcel
  ON public.parcel_ownerships(parcel_id);

CREATE TABLE IF NOT EXISTS public.parcel_kouku (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  rank TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  received_at TEXT,
  receipt_number TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parcel_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_parcel_kouku_parcel
  ON public.parcel_kouku(parcel_id);

CREATE TABLE IF NOT EXISTS public.parcel_otoku (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id UUID NOT NULL REFERENCES public.parcels(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  rank TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  received_at TEXT,
  receipt_number TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parcel_id, order_no)
);
CREATE INDEX IF NOT EXISTS idx_parcel_otoku_parcel
  ON public.parcel_otoku(parcel_id);

-- ============================================
-- 6. RLS: parcels の 子 は parcel 経由 で 判定
-- ============================================

CREATE OR REPLACE FUNCTION public.fn_parcel_child_can_view(p_parcel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.parcels p
    JOIN public.design_work_areas wa ON wa.id = p.work_area_id
    JOIN public.farms f ON f.id = wa.farm_id
    WHERE p.id = p_parcel_id
      AND public.is_project_viewer(f.project_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_parcel_child_can_edit(p_parcel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.parcels p
    JOIN public.design_work_areas wa ON wa.id = p.work_area_id
    JOIN public.farms f ON f.id = wa.farm_id
    WHERE p.id = p_parcel_id
      AND public.is_project_editor(f.project_id)
  );
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parcel_locations',
    'parcel_display_histories',
    'parcel_ownerships',
    'parcel_kouku',
    'parcel_otoku'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (public.fn_parcel_child_can_view(parcel_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.fn_parcel_child_can_edit(parcel_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.fn_parcel_child_can_edit(parcel_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.fn_parcel_child_can_edit(parcel_id))',
      t, t
    );
  END LOOP;
END $$;

COMMIT;
