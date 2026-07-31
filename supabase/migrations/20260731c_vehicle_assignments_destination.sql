-- vehicle_assignments に「現在ドライバーが向かっている行き先」列を追加。
-- 目的:
--   ・運行管理者画面 (フリート地図) から、各ドライバーがどこに向かっているか
--     一目でわかるように共有する。
--   ・destination_point_id は mobility_project_points への FK。
--     ドライバー側の localStorage 永続化はあくまで自端末の復元用で、
--     サーバー側の権威データはこの列。
--
-- 適用: Supabase Dashboard → SQL Editor で実行 (冪等)。

ALTER TABLE public.vehicle_assignments
  ADD COLUMN IF NOT EXISTS destination_point_id uuid
    REFERENCES public.mobility_project_points(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_set_at timestamptz;

COMMENT ON COLUMN public.vehicle_assignments.destination_point_id IS
  'ドライバーが選択中の行き先ポイント (mobility_project_points)。NULL = 未設定。';
COMMENT ON COLUMN public.vehicle_assignments.destination_set_at IS
  '行き先が最後に更新された時刻。';

CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_destination
  ON public.vehicle_assignments (destination_point_id)
  WHERE destination_point_id IS NOT NULL;

-- Realtime 配信対象に vehicle_assignments を追加 (行き先変更を管理者画面に即反映)
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.vehicle_assignments;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;  -- supabase_realtime が無い環境
  END;
END $$;
