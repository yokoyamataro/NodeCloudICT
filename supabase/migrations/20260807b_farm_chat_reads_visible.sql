-- 工区チャットの既読情報 (farm_chat_reads) を他ユーザーからも SELECT できるようにする。
-- これまでは「自分の行のみ ALL 可」だったので他人の既読時刻が見えず、
-- 「誰が既読か」表示が実装できなかった。
--
-- - SELECT: 同じ工区 (プロジェクトメンバー) なら誰でも
-- - INSERT/UPDATE/DELETE: 自分の行のみ (従来通り)
-- あわせて Realtime publication にも追加して即時反映できるようにする。

DROP POLICY IF EXISTS farm_chat_reads_all ON public.farm_chat_reads;
DROP POLICY IF EXISTS farm_chat_reads_select ON public.farm_chat_reads;
DROP POLICY IF EXISTS farm_chat_reads_insert ON public.farm_chat_reads;
DROP POLICY IF EXISTS farm_chat_reads_update ON public.farm_chat_reads;
DROP POLICY IF EXISTS farm_chat_reads_delete ON public.farm_chat_reads;

CREATE POLICY farm_chat_reads_select ON public.farm_chat_reads FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_chat_reads.farm_id
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

CREATE POLICY farm_chat_reads_insert ON public.farm_chat_reads FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY farm_chat_reads_update ON public.farm_chat_reads FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY farm_chat_reads_delete ON public.farm_chat_reads FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Realtime publication に追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'farm_chat_reads'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_chat_reads';
  END IF;
END $$;
