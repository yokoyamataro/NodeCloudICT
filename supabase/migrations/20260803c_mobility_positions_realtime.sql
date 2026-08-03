-- ============================================================
-- mobility_positions を Supabase Realtime publication に追加
--
-- 背景:
--   フリート地図 (FleetMapView) は mobility_positions への INSERT を
--   Realtime で受け取って即時マップに反映する設計だが、テーブルが
--   publication (supabase_realtime) に登録されていなかった。
--   → Realtime callback が発火せず、15秒ポーリングだけに頼っていた。
--   このためタイミング次第で「通信断 x分前」と表示される事象が発生。
--
-- 依存:
--   Supabase の default publication 'supabase_realtime' が存在すること。
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'mobility_positions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.mobility_positions';
  END IF;
END $$;
