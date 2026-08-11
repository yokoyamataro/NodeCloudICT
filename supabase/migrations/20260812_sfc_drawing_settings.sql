-- ============================================================
-- 工区単位で SFC 平面図出力の 図面レベルパラメータ を保存する
-- (原点 X, Y (実 m) / 回転角 度分秒 / 現地座標保持)
--
-- 1 farm = 1 行 (PRIMARY KEY (farm_id))。未登録の工区は
-- クライアント側で default 値を使う。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sfc_drawing_settings (
  farm_id uuid PRIMARY KEY REFERENCES public.farms(id) ON DELETE CASCADE,
  origin_x double precision,
  origin_y double precision,
  rotation_deg integer NOT NULL DEFAULT 0,
  rotation_min integer NOT NULL DEFAULT 0,
  rotation_sec double precision NOT NULL DEFAULT 0,
  preserve_survey_coords boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sfc_drawing_settings IS
  '工区ごとの SFC 平面図 図面レベルパラメータ (原点 / 回転 / 現地座標保持)';

-- ========================================================================
-- RLS: プロジェクトメンバーなら SELECT/INSERT/UPDATE/DELETE できる
-- (farm_messages 等と同じパターン)
-- ========================================================================
ALTER TABLE public.sfc_drawing_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sfc_drawing_settings_select ON public.sfc_drawing_settings;
CREATE POLICY sfc_drawing_settings_select ON public.sfc_drawing_settings FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = sfc_drawing_settings.farm_id
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

DROP POLICY IF EXISTS sfc_drawing_settings_upsert ON public.sfc_drawing_settings;
CREATE POLICY sfc_drawing_settings_upsert ON public.sfc_drawing_settings FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = sfc_drawing_settings.farm_id
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

DROP POLICY IF EXISTS sfc_drawing_settings_update ON public.sfc_drawing_settings;
CREATE POLICY sfc_drawing_settings_update ON public.sfc_drawing_settings FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = sfc_drawing_settings.farm_id
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

DROP POLICY IF EXISTS sfc_drawing_settings_delete ON public.sfc_drawing_settings;
CREATE POLICY sfc_drawing_settings_delete ON public.sfc_drawing_settings FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = sfc_drawing_settings.farm_id
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
