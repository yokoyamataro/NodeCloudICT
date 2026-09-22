-- 法務局備付地図作成作業: 登記 CSV (法務局 4600 形式) の 取込先 と、
-- 地図作成 現場 (project) 単位 で 独立管理 する 地権者リスト。
--
-- ●設計 の 意図
--   ・既存 の parcels / landowners / parcel_landowners には 一切 影響 を 与えない。
--     地図作成作業 で 使う テーブル群 は 完全 に 別系統 として 追加する。
--   ・粒度 は プロジェクト単位。 CSV は 複数工区 に またがる ため、工区 (farm) に
--     縛ら ない 方が 実運用 に 合う。
--   ・CSV 原文 (所在 / 表示 / 所有 / 甲区 / 乙区 の 履歴) は
--     registry_locations / registry_display_histories / registry_ownerships /
--     registry_kouku / registry_otoku に 生 で 保存 する (参照専用)。
--   ・地権者リスト (project_owners) は CSV 取込 時 に 自動 作成 され、
--     以後 現場担当 が 氏名/住所/電話/代理人/立会 を 編集 する。
--     登記 の 情報 と 地権者リスト は 独立 (同姓同名 + 同住所 だけ を
--     自動 同一 判定、氏名 のみ 一致 は 手動 確認 で マージ)。
--   ・持分 は property_owner_shares (property × project_owner) で 複数行。
--
-- ●合筆 / 分筆
--   ・合筆残地: initial_area_sqm (当初), finalized_area_sqm (確定),
--               merged_area_sqm (合筆後) の 3 種 を 持つ。
--               merged_into_property_id は NULL。
--   ・合筆消滅地: merged_into_property_id で 合筆先 (残地) を 参照。
--                 merged_area_sqm は NULL。
--   ・分筆元地: split_from_property_id は NULL (被 参照 側)。
--   ・分筆新地: split_from_property_id で 分筆元 を 参照。

BEGIN;

-- ============================================================
-- 1. registry_properties (物件 = 地番 本体)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- CSV 由来 の 基本情報
  seq INTEGER NOT NULL,                -- CSV 内 の 連番
  kind TEXT NOT NULL DEFAULT '',       -- 土地 / 建物
  status TEXT NOT NULL DEFAULT '',     -- 既存 / 登記済 など
  location TEXT NOT NULL DEFAULT '',   -- 所在 (物件情報行 の 値)
  parcel_number TEXT NOT NULL DEFAULT '',
  real_estate_number TEXT NOT NULL DEFAULT '',

  -- 現場 で 確定 させる 値
  finalized_land_category TEXT,        -- 確定地目
  initial_area_sqm NUMERIC(14, 2),     -- 当初地積 (登記地積)
  finalized_area_sqm NUMERIC(14, 2),   -- 確定地積 (測量結果)

  -- 合筆
  merged_area_sqm NUMERIC(14, 2),      -- 合筆後地積 (合筆残地 のみ)
  merged_into_property_id UUID
    REFERENCES public.registry_properties(id) ON DELETE SET NULL,
  merged_at DATE,

  -- 分筆
  split_from_property_id UUID
    REFERENCES public.registry_properties(id) ON DELETE SET NULL,
  split_at DATE,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 同 project 内 で seq は 一意 (CSV 内 の 連番 を そのまま 使う)
  UNIQUE (project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_registry_properties_project
  ON public.registry_properties(project_id);
CREATE INDEX IF NOT EXISTS idx_registry_properties_parcel_number
  ON public.registry_properties(project_id, parcel_number);
CREATE INDEX IF NOT EXISTS idx_registry_properties_merged_into
  ON public.registry_properties(merged_into_property_id)
  WHERE merged_into_property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_registry_properties_split_from
  ON public.registry_properties(split_from_property_id)
  WHERE split_from_property_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_registry_properties_updated_at
  ON public.registry_properties;
CREATE TRIGGER update_registry_properties_updated_at
  BEFORE UPDATE ON public.registry_properties
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. registry_locations (所在履歴 - CSV 原文)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  change_reason TEXT,
  registered_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_registry_locations_property
  ON public.registry_locations(property_id);

-- ============================================================
-- 3. registry_display_histories (表示履歴 - CSV 原文)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_display_histories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  parcel_number TEXT NOT NULL DEFAULT '',
  land_category TEXT NOT NULL DEFAULT '',
  area_text TEXT NOT NULL DEFAULT '',   -- 「２３２・３２」等、生表記 (半角化のみ)
  reason TEXT,
  cause_date TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_registry_display_histories_property
  ON public.registry_display_histories(property_id);

-- ============================================================
-- 4. registry_ownerships (登記所有権 - CSV 原文、参照専用)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_ownerships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  share TEXT NOT NULL DEFAULT '',        -- 「持分12分の2」等
  owner_name TEXT NOT NULL DEFAULT '',
  extra TEXT,
  received_at TEXT,
  receipt_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_registry_ownerships_property
  ON public.registry_ownerships(property_id);

-- ============================================================
-- 5. registry_kouku (甲区 - 所有権 に 関する 事項)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_kouku (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  rank TEXT NOT NULL DEFAULT '',         -- 順位番号 (例: "2" "1付記1号")
  purpose TEXT NOT NULL DEFAULT '',      -- 登記 の 目的
  received_at TEXT,
  receipt_number TEXT,
  detail TEXT,                            -- 原因 / 権利者 / 債務者 の 本文
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_registry_kouku_property
  ON public.registry_kouku(property_id);

-- ============================================================
-- 6. registry_otoku (乙区 - 所有権 以外 の 権利)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.registry_otoku (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  rank TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  received_at TEXT,
  receipt_number TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, order_no)
);

CREATE INDEX IF NOT EXISTS idx_registry_otoku_property
  ON public.registry_otoku(property_id);

-- ============================================================
-- 7. project_owners (地権者リスト - 現場 = project 単位)
-- ============================================================
-- 既存 landowners (工区単位) と は 別系統。 立会情報 と 代理人 情報 を 持つ。
-- 立会状況 は text (候補 例: 立会済 / 未立会 / 不在 / 欠席 / 拒否 / 死亡 /
-- 相続手続中 / その他)。 UI 側 で 候補 選択 + 「その他」 選択時 に 自由入力。
CREATE TABLE IF NOT EXISTS public.project_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,

  -- 代理人 (相続人 / 委任 先 など)
  agent_name TEXT,
  agent_address TEXT,
  agent_phone TEXT,

  -- 立会
  first_visit_at TIMESTAMPTZ,
  first_visit_status TEXT,
  second_visit_at TIMESTAMPTZ,
  second_visit_status TEXT,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_owners_project
  ON public.project_owners(project_id);
-- 名寄せ 用: 同 project 内 で 氏名 + 住所 が 一致 する owner を 高速 探索
CREATE INDEX IF NOT EXISTS idx_project_owners_name_address
  ON public.project_owners(project_id, name, address);

DROP TRIGGER IF EXISTS update_project_owners_updated_at
  ON public.project_owners;
CREATE TRIGGER update_project_owners_updated_at
  BEFORE UPDATE ON public.project_owners
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 8. property_owner_shares (持分 ジャンクション)
-- ============================================================
-- 1 property × 1 project_owner = 1 行。 共有 の 場合 は 同 property_id で 複数行。
-- share は 「12分の1」 等 の 登記 表記 を そのまま 保持。
CREATE TABLE IF NOT EXISTS public.property_owner_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES public.registry_properties(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL
    REFERENCES public.project_owners(id) ON DELETE CASCADE,
  share TEXT NOT NULL DEFAULT '',
  order_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, owner_id, share)
);

CREATE INDEX IF NOT EXISTS idx_property_owner_shares_property
  ON public.property_owner_shares(property_id);
CREATE INDEX IF NOT EXISTS idx_property_owner_shares_owner
  ON public.property_owner_shares(owner_id);

-- ============================================================
-- RLS: すべて プロジェクト メンバー方式
-- ============================================================
-- registry_* (CSV 原文): editor 権限 で 取込・削除、 viewer で 参照。
-- project_owners / property_owner_shares: editor で 編集。

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_properties',
    'registry_locations',
    'registry_display_histories',
    'registry_ownerships',
    'registry_kouku',
    'registry_otoku',
    'project_owners',
    'property_owner_shares'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- project_id を 直接 持つ テーブル は そのまま viewer / editor で 判定
DROP POLICY IF EXISTS "registry_properties_select" ON public.registry_properties;
DROP POLICY IF EXISTS "registry_properties_insert" ON public.registry_properties;
DROP POLICY IF EXISTS "registry_properties_update" ON public.registry_properties;
DROP POLICY IF EXISTS "registry_properties_delete" ON public.registry_properties;

CREATE POLICY "registry_properties_select" ON public.registry_properties
  FOR SELECT USING (public.is_project_viewer(project_id));
CREATE POLICY "registry_properties_insert" ON public.registry_properties
  FOR INSERT WITH CHECK (public.is_project_editor(project_id));
CREATE POLICY "registry_properties_update" ON public.registry_properties
  FOR UPDATE USING (public.is_project_editor(project_id));
CREATE POLICY "registry_properties_delete" ON public.registry_properties
  FOR DELETE USING (public.is_project_editor(project_id));

DROP POLICY IF EXISTS "project_owners_select" ON public.project_owners;
DROP POLICY IF EXISTS "project_owners_insert" ON public.project_owners;
DROP POLICY IF EXISTS "project_owners_update" ON public.project_owners;
DROP POLICY IF EXISTS "project_owners_delete" ON public.project_owners;

CREATE POLICY "project_owners_select" ON public.project_owners
  FOR SELECT USING (public.is_project_viewer(project_id));
CREATE POLICY "project_owners_insert" ON public.project_owners
  FOR INSERT WITH CHECK (public.is_project_editor(project_id));
CREATE POLICY "project_owners_update" ON public.project_owners
  FOR UPDATE USING (public.is_project_editor(project_id));
CREATE POLICY "project_owners_delete" ON public.project_owners
  FOR DELETE USING (public.is_project_editor(project_id));

-- 子 テーブル は 親 property → project_id を 辿って 判定
CREATE OR REPLACE FUNCTION public.fn_registry_child_can_view(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.registry_properties p
    WHERE p.id = p_property_id
      AND public.is_project_viewer(p.project_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.fn_registry_child_can_edit(p_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.registry_properties p
    WHERE p.id = p_property_id
      AND public.is_project_editor(p.project_id)
  );
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_locations',
    'registry_display_histories',
    'registry_ownerships',
    'registry_kouku',
    'registry_otoku'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (public.fn_registry_child_can_view(property_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.fn_registry_child_can_edit(property_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.fn_registry_child_can_edit(property_id))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.fn_registry_child_can_edit(property_id))',
      t, t
    );
  END LOOP;
END $$;

-- property_owner_shares は property_id 経由 で 判定
DROP POLICY IF EXISTS "property_owner_shares_select" ON public.property_owner_shares;
DROP POLICY IF EXISTS "property_owner_shares_insert" ON public.property_owner_shares;
DROP POLICY IF EXISTS "property_owner_shares_update" ON public.property_owner_shares;
DROP POLICY IF EXISTS "property_owner_shares_delete" ON public.property_owner_shares;

CREATE POLICY "property_owner_shares_select" ON public.property_owner_shares
  FOR SELECT USING (public.fn_registry_child_can_view(property_id));
CREATE POLICY "property_owner_shares_insert" ON public.property_owner_shares
  FOR INSERT WITH CHECK (public.fn_registry_child_can_edit(property_id));
CREATE POLICY "property_owner_shares_update" ON public.property_owner_shares
  FOR UPDATE USING (public.fn_registry_child_can_edit(property_id));
CREATE POLICY "property_owner_shares_delete" ON public.property_owner_shares
  FOR DELETE USING (public.fn_registry_child_can_edit(property_id));

COMMIT;
