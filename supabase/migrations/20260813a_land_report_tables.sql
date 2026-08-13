-- ============================================================
-- 土地調査報告書 (境界測量) 関連 3 テーブル
--   1. organization_surveyors        -- 会社に所属する 土地家屋調査士 (氏名/登録番号/所属会/電話)
--   2. organization_report_snippets  -- 会社共通の 定型文集 (原本確認結果 / 三角点測量不可理由 / 補足特記事項)
--   3. land_reports                  -- 工区ごとに 複数の 調査報告書 (body は jsonb で全入力を保持)
--
-- RLS:
--   * SELECT: 組織メンバー
--   * INSERT/UPDATE/DELETE: 組織 admin (is_admin_of_org)
--     (land_reports は 例外: 工区にアクセスできる メンバー全員が編集可)
-- ============================================================

-- ============================================================
-- 1. organization_surveyors
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organization_surveyors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,          -- 土地家屋調査士名
  registration_no   text,                   -- 登録番号
  office_name       text,                   -- 所属調査士会 (例: 釧路土地家屋調査士会所属)
  phone_no          text,                   -- 電話番号
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_surveyors_org
  ON public.organization_surveyors (organization_id, sort_order);

DROP TRIGGER IF EXISTS trg_org_surveyors_touch ON public.organization_surveyors;
CREATE TRIGGER trg_org_surveyors_touch
  BEFORE UPDATE ON public.organization_surveyors
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.organization_surveyors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_surveyors_select" ON public.organization_surveyors;
CREATE POLICY "org_surveyors_select" ON public.organization_surveyors
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = organization_surveyors.organization_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "org_surveyors_insert" ON public.organization_surveyors;
CREATE POLICY "org_surveyors_insert" ON public.organization_surveyors
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_of_org(organization_id));

DROP POLICY IF EXISTS "org_surveyors_update" ON public.organization_surveyors;
CREATE POLICY "org_surveyors_update" ON public.organization_surveyors
  FOR UPDATE TO authenticated
  USING (public.is_admin_of_org(organization_id))
  WITH CHECK (public.is_admin_of_org(organization_id));

DROP POLICY IF EXISTS "org_surveyors_delete" ON public.organization_surveyors;
CREATE POLICY "org_surveyors_delete" ON public.organization_surveyors
  FOR DELETE TO authenticated
  USING (public.is_admin_of_org(organization_id));

-- ============================================================
-- 2. organization_report_snippets
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organization_report_snippets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category          text NOT NULL CHECK (category IN (
    'original_check',           -- 06 原本結果確認
    'no_triangulation_reason',  -- 09 基本三角点等に基づく測量ができない理由
    'remark'                    -- 10 補足・特記事項
  )),
  label             text NOT NULL,   -- 定型文一覧に出す短いラベル
  body              text NOT NULL,   -- 挿入される本文
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_snippets_org_cat
  ON public.organization_report_snippets (organization_id, category, sort_order);

DROP TRIGGER IF EXISTS trg_org_snippets_touch ON public.organization_report_snippets;
CREATE TRIGGER trg_org_snippets_touch
  BEFORE UPDATE ON public.organization_report_snippets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.organization_report_snippets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_snippets_select" ON public.organization_report_snippets;
CREATE POLICY "org_snippets_select" ON public.organization_report_snippets
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = organization_report_snippets.organization_id
        AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "org_snippets_insert" ON public.organization_report_snippets;
CREATE POLICY "org_snippets_insert" ON public.organization_report_snippets
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_of_org(organization_id));

DROP POLICY IF EXISTS "org_snippets_update" ON public.organization_report_snippets;
CREATE POLICY "org_snippets_update" ON public.organization_report_snippets
  FOR UPDATE TO authenticated
  USING (public.is_admin_of_org(organization_id))
  WITH CHECK (public.is_admin_of_org(organization_id));

DROP POLICY IF EXISTS "org_snippets_delete" ON public.organization_report_snippets;
CREATE POLICY "org_snippets_delete" ON public.organization_report_snippets
  FOR DELETE TO authenticated
  USING (public.is_admin_of_org(organization_id));

-- ============================================================
-- 3. land_reports
-- ============================================================
CREATE TABLE IF NOT EXISTS public.land_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id           uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  title             text NOT NULL DEFAULT '無題の調査報告書',
  body              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_land_reports_farm
  ON public.land_reports (farm_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_land_reports_touch ON public.land_reports;
CREATE TRIGGER trg_land_reports_touch
  BEFORE UPDATE ON public.land_reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.land_reports ENABLE ROW LEVEL SECURITY;

-- 報告書は 「工区にアクセスできる プロジェクトメンバー」 なら 全員 CRUD 可能。
-- (farm → project → project_members / farms.user_id で判定)
DROP POLICY IF EXISTS "land_reports_all" ON public.land_reports;
CREATE POLICY "land_reports_all" ON public.land_reports
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_reports.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = land_reports.farm_id
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

COMMENT ON TABLE public.organization_surveyors IS
  '組織 (会社) に所属する 土地家屋調査士。1 組織 N 調査士。報告書ヘッダで選択する';
COMMENT ON TABLE public.organization_report_snippets IS
  '会社共通の 定型文集。カテゴリ: original_check / no_triangulation_reason / remark';
COMMENT ON TABLE public.land_reports IS
  '土地調査報告書 (境界測量)。1 工区 N 報告書。body は 全入力を jsonb で保持';
