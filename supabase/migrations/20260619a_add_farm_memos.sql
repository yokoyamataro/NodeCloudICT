-- 工区メモ機能: 1 件 1 行で farm_memos に蓄える。
--
-- 用途:
--   現場で気付いた事項（位置情報・方向 + テキスト + 写真）を残す。
--   写真は attachments テーブルを entity_type='farm_memo' で流用するので
--   ここでは保持しない（写真パイプラインは座標写真と同じ）。
--
-- フィールド:
--   id            uuid       主キー
--   farm_id       uuid       FK -> farms(id) ON DELETE CASCADE
--   user_id       uuid       作成者 (auth.users)
--   content       text       本文
--   lat/lng       numeric    任意。GPS から取得した位置（WGS84）
--   heading_deg   numeric    任意。端末の方向（0=北, 90=東 ... 359.999）
--   created_at    timestamptz
--   updated_at    timestamptz
--
-- RLS:
--   farm 経由のメンバーシップ判定。owner / editor が CRUD、viewer は SELECT のみ。
--   既存 design_work_areas RLS と同じパターンに合わせる。

CREATE TABLE IF NOT EXISTS public.farm_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  content text NOT NULL DEFAULT '',
  lat double precision,
  lng double precision,
  heading_deg double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_farm_memos_farm_id
  ON public.farm_memos (farm_id);

-- updated_at 自動更新トリガ
DROP TRIGGER IF EXISTS trg_farm_memos_touch ON public.farm_memos;
CREATE TRIGGER trg_farm_memos_touch
  BEFORE UPDATE ON public.farm_memos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- RLS
-- ========================================================================
ALTER TABLE public.farm_memos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS farm_memos_select ON public.farm_memos;
DROP POLICY IF EXISTS farm_memos_insert ON public.farm_memos;
DROP POLICY IF EXISTS farm_memos_update ON public.farm_memos;
DROP POLICY IF EXISTS farm_memos_delete ON public.farm_memos;

CREATE POLICY farm_memos_select ON public.farm_memos FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_memos.farm_id
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

CREATE POLICY farm_memos_insert ON public.farm_memos FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_memos.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY farm_memos_update ON public.farm_memos FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_memos.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_memos.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );

CREATE POLICY farm_memos_delete ON public.farm_memos FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_memos.farm_id
        AND (
          f.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = f.project_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('owner', 'editor')
          )
        )
    )
  );
