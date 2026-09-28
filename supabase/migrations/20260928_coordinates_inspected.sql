-- 座標 の 点検 状態 を 記録 する。
--   inspected_at TIMESTAMPTZ — 点検 済み の 時刻。 NULL で 未点検。
--   inspected_by UUID (auth.users) — 点検 した ユーザー。
--
-- チェック ON → inspected_at=now(), inspected_by=auth.uid()
-- チェック OFF → 両方 NULL に 戻す
-- 「点検 は チェック した ユーザー が 記録 される」 の 実装。

BEGIN;

ALTER TABLE public.design_coordinates
  ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inspected_by UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_design_coordinates_inspected_by
  ON public.design_coordinates(inspected_by);

NOTIFY pgrst, 'reload schema';

COMMIT;
