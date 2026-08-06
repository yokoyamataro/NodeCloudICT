-- ============================================================
-- 工区チャット: farm_messages と farm_chat_reads の 2 テーブル
--
-- farm_messages: 1 工区の全チャットログ (時系列)
-- farm_chat_reads: 各ユーザーの工区ごとの最終既読時刻
--   → 未読数 = farm_messages.created_at > last_read_at の件数
--
-- RLS は farm_memos と同じ「プロジェクトメンバーなら SELECT/INSERT 可、
-- owner/editor が編集」パターンに合わせる。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.farm_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  sender_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.farm_messages IS
  '工区単位のチャットメッセージ。1 farm = 1 チャンネル';

CREATE INDEX IF NOT EXISTS idx_farm_messages_farm_time
  ON public.farm_messages (farm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.farm_chat_reads (
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id)
);

COMMENT ON TABLE public.farm_chat_reads IS
  'ユーザーごとの工区チャット既読時刻。未読数計算に使う';

-- ========================================================================
-- RLS
-- ========================================================================
ALTER TABLE public.farm_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_chat_reads ENABLE ROW LEVEL SECURITY;

-- farm_messages: プロジェクトメンバーなら誰でも SELECT/INSERT 可能。
-- UPDATE/DELETE は送信者本人のみ (雑に間違えたら消せる程度で十分)。
DROP POLICY IF EXISTS farm_messages_select ON public.farm_messages;
CREATE POLICY farm_messages_select ON public.farm_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_messages.farm_id
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

DROP POLICY IF EXISTS farm_messages_insert ON public.farm_messages;
CREATE POLICY farm_messages_insert ON public.farm_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.farms f
      WHERE f.id = farm_messages.farm_id
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

DROP POLICY IF EXISTS farm_messages_update ON public.farm_messages;
CREATE POLICY farm_messages_update ON public.farm_messages FOR UPDATE
  TO authenticated
  USING (sender_user_id = auth.uid())
  WITH CHECK (sender_user_id = auth.uid());

DROP POLICY IF EXISTS farm_messages_delete ON public.farm_messages;
CREATE POLICY farm_messages_delete ON public.farm_messages FOR DELETE
  TO authenticated
  USING (sender_user_id = auth.uid());

-- farm_chat_reads: 自分の行のみ CRUD 可能
DROP POLICY IF EXISTS farm_chat_reads_all ON public.farm_chat_reads;
CREATE POLICY farm_chat_reads_all ON public.farm_chat_reads FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ========================================================================
-- Realtime: farm_messages を配信 (新着メッセージのバッジ即時更新)
-- ========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'farm_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_messages';
  END IF;
END $$;
