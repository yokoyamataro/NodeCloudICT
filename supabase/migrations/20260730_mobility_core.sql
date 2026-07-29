-- モビリティ機能の中核 3 テーブル。
--
-- テーブル構成:
--   vehicles              — 車両/重機マスタ (組織ごと)
--   vehicle_assignments   — 「誰がいつからいつまでこの車両に乗ったか」の時系列。
--                           降車したら ended_at を埋める。ended_at IS NULL = 稼働中。
--   mobility_positions    — GPS ping。assignment_id に紐付くので「誰の / どの車両の
--                           / いつの位置」が 1 行から自動で判別できる。
--
-- 設計方針:
--   * organization_id は vehicles にだけ持たせ、assignments / positions は
--     vehicle_id → vehicles → organization_id で辿る (正規化)。
--   * 座席課金 (organization_product_members with product='mobility') はこの
--     段階では実装しない。RLS は組織スコープの単純判定のみ。次段階の契約管理
--     UI と併せて has_org_product('mobility') 等でゲートを足す。
--   * positions は immutable。作成後の UPDATE/DELETE は許可しない (RLS で拒否)。
--     ゴミ掃除は org admin による assignment ごとまとめ削除で対応する想定。
--   * partition はまだ張らない。数千万行を超えたら (vehicle_id, recorded_at) で
--     range partition する候補。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行 (冪等)。

-- ============================================================
-- 1. vehicles
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,                           -- 表示名 (例: '2号車', 'バックホウA')
  plate_or_serial text,                         -- ナンバープレート / 機械番号
  kind text NOT NULL DEFAULT 'car'
    CHECK (kind IN ('car', 'truck', 'heavy_equipment', 'other')),
  active boolean NOT NULL DEFAULT true,         -- 廃車/売却時に false へ
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vehicles IS
  '組織が保有する車両・重機のマスタ。同一組織内で同じ名前を許容する (現場で通称重複あり得るため)';

CREATE INDEX IF NOT EXISTS idx_vehicles_organization
  ON public.vehicles (organization_id) WHERE active = true;

CREATE OR REPLACE FUNCTION public.tg_vehicles_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_vehicles_touch ON public.vehicles;
CREATE TRIGGER trg_vehicles_touch BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.tg_vehicles_touch();

-- ============================================================
-- 2. vehicle_assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicle_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,                         -- NULL = 稼働中
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

COMMENT ON TABLE public.vehicle_assignments IS
  '車両と運転者の紐付きの時系列。ended_at IS NULL の行が現在乗車中。';

CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_active
  ON public.vehicle_assignments (vehicle_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_user_time
  ON public.vehicle_assignments (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_vehicle_time
  ON public.vehicle_assignments (vehicle_id, started_at DESC);

-- 「1 車両につき『稼働中』は最大 1 件」を保証する部分 UNIQUE 索引
CREATE UNIQUE INDEX IF NOT EXISTS uidx_vehicle_assignments_one_active_per_vehicle
  ON public.vehicle_assignments (vehicle_id) WHERE ended_at IS NULL;

-- ============================================================
-- 3. mobility_positions
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mobility_positions (
  id bigserial PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES public.vehicle_assignments(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  accuracy_m real,                              -- GPS 精度 (メートル)
  speed_kmh real,                               -- 速度 (km/h) 停止時は 0 or NULL
  heading_deg real,                             -- 進行方位 (0-360)
  altitude_m real                               -- 高度 (メートル)
);

COMMENT ON TABLE public.mobility_positions IS
  'GPS ping 生データ。assignment_id 経由で運転者と車両を辿れる。';

CREATE INDEX IF NOT EXISTS idx_mobility_positions_assignment_time
  ON public.mobility_positions (assignment_id, recorded_at DESC);

-- ============================================================
-- 4. 権限判定ヘルパ (RLS で使う)
--    vehicle → organization → 組織メンバーか?
--    直接 JOIN するとポリシー中で SELECT が発生してループしうるので、
--    SECURITY DEFINER の SQL 関数に外出しする。
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_org_member_of_vehicle(v_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles v
    JOIN public.organization_members om ON om.organization_id = v.organization_id
    WHERE v.id = v_vehicle_id AND om.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin_of_vehicle(v_vehicle_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles v
    WHERE v.id = v_vehicle_id
      AND public.is_admin_of_org(v.organization_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_member_of_assignment(v_assignment_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicle_assignments a
    JOIN public.vehicles v ON v.id = a.vehicle_id
    JOIN public.organization_members om ON om.organization_id = v.organization_id
    WHERE a.id = v_assignment_id AND om.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_member_of_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_admin_of_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_member_of_assignment(uuid) TO authenticated;

-- ============================================================
-- 5. RLS - vehicles
-- ============================================================
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicles_select ON public.vehicles;
DROP POLICY IF EXISTS vehicles_insert ON public.vehicles;
DROP POLICY IF EXISTS vehicles_update ON public.vehicles;
DROP POLICY IF EXISTS vehicles_delete ON public.vehicles;

-- SELECT: 同組織メンバー全員 + サイトオーナー
CREATE POLICY vehicles_select ON public.vehicles FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = vehicles.organization_id
    )
  );

-- INSERT/UPDATE/DELETE: 組織 admin + サイトオーナー
CREATE POLICY vehicles_insert ON public.vehicles FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
  );
CREATE POLICY vehicles_update ON public.vehicles FOR UPDATE
  TO authenticated
  USING (public.is_site_owner() OR public.is_admin_of_org(organization_id))
  WITH CHECK (public.is_site_owner() OR public.is_admin_of_org(organization_id));
CREATE POLICY vehicles_delete ON public.vehicles FOR DELETE
  TO authenticated
  USING (public.is_site_owner() OR public.is_admin_of_org(organization_id));

-- ============================================================
-- 6. RLS - vehicle_assignments
-- ============================================================
ALTER TABLE public.vehicle_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_assignments_select ON public.vehicle_assignments;
DROP POLICY IF EXISTS vehicle_assignments_insert ON public.vehicle_assignments;
DROP POLICY IF EXISTS vehicle_assignments_update ON public.vehicle_assignments;
DROP POLICY IF EXISTS vehicle_assignments_delete ON public.vehicle_assignments;

-- SELECT: 同組織メンバー全員 + サイトオーナー
CREATE POLICY vehicle_assignments_select ON public.vehicle_assignments FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member_of_vehicle(vehicle_id)
  );

-- INSERT: 「自分自身を割り当てる」or「組織 admin」or サイトオーナー
--   ドライバーが乗る時に自分でセルフ割当 (user_id = auth.uid())
--   admin は他人を割当てられる
CREATE POLICY vehicle_assignments_insert ON public.vehicle_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR public.is_org_admin_of_vehicle(vehicle_id)
    OR (user_id = auth.uid() AND public.is_org_member_of_vehicle(vehicle_id))
  );

-- UPDATE: 自分の assignment を閉じる or admin
CREATE POLICY vehicle_assignments_update ON public.vehicle_assignments FOR UPDATE
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_admin_of_vehicle(vehicle_id)
    OR user_id = auth.uid()
  )
  WITH CHECK (
    public.is_site_owner()
    OR public.is_org_admin_of_vehicle(vehicle_id)
    OR user_id = auth.uid()
  );

-- DELETE: admin only
CREATE POLICY vehicle_assignments_delete ON public.vehicle_assignments FOR DELETE
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_admin_of_vehicle(vehicle_id)
  );

-- ============================================================
-- 7. RLS - mobility_positions
-- ============================================================
ALTER TABLE public.mobility_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mobility_positions_select ON public.mobility_positions;
DROP POLICY IF EXISTS mobility_positions_insert ON public.mobility_positions;

-- SELECT: 同組織メンバー全員 + サイトオーナー
CREATE POLICY mobility_positions_select ON public.mobility_positions FOR SELECT
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_org_member_of_assignment(assignment_id)
  );

-- INSERT: assignment の user_id 本人だけが自分の ping を送れる
--   (端末から送られてくる想定。他人の assignment に書き込むのを防ぐ)
CREATE POLICY mobility_positions_insert ON public.mobility_positions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.vehicle_assignments a
      WHERE a.id = mobility_positions.assignment_id
        AND a.user_id = auth.uid()
        AND a.ended_at IS NULL          -- 閉じた assignment には打てない
    )
  );

-- UPDATE / DELETE ポリシーを作らない = 全ユーザー拒否 (immutable)
-- サイトオーナーが CASCADE で消したい時は assignment ごと削除する運用
