-- 工区 (farms) に 着手日 / 完成日 の記録用カラムを追加。
--
-- 用途:
--   工区の情報編集モーダルで 着手日・完成日 を表示・編集できるようにする。
--   完成日は「完了」チェックの状態と連動する:
--     - チェック ON  → completed_at に now() (未セット時のみ)
--     - チェック OFF → completed_at = NULL
--   着手日は工区作成時に created_at を初期値としてセットする (default now() でも実用上 OK)。
--   どちらも編集モーダルからユーザーが後で書き換え可能。

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 既存行のバックフィル:
-- 着手日は 作成日 (created_at) を初期値とみなす
UPDATE public.farms
   SET started_at = created_at
 WHERE started_at IS NULL;

-- 完成日は、farm_work_status に status='completed' の行がある工区について、
-- 便宜的に updated_at を採用する (正確な完了時刻は残っていないため)
UPDATE public.farms f
   SET completed_at = f.updated_at
 WHERE completed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.farm_work_status ws
     WHERE ws.farm_id = f.id AND ws.status = 'completed'
   );
