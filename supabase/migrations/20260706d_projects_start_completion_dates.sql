-- 現場 (projects) に 着手日 / 完成日 の記録用カラムを追加。
--
-- 用途:
--   工区 (farms) と同じく現場単位でも進捗管理を可能にする。
--   完成日は「完了」チェックの状態と連動:
--     - チェック ON  → completed_at に now() (未セット時のみ)
--     - チェック OFF → completed_at = NULL
--   着手日は現場作成時に created_at を初期値としてセット (default now() でも実用上 OK)。
--   どちらも編集モーダルからユーザーが後で書き換え可能。
--
-- 補足:
--   projects には 既に start_date / end_date (工期) があるが、これは 「予定」 の
--   期間を表す DATE 型。started_at / completed_at は 「実際の」 着手・完成時刻を
--   TIMESTAMPTZ で持つ (工区と同じセマンティクス)。

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 既存行のバックフィル
UPDATE public.projects
   SET started_at = created_at
 WHERE started_at IS NULL;
