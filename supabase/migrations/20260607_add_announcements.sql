-- 開発者からユーザーへの「お知らせ」機能。
--
-- テーブル:
--   announcements        : お知らせ本体（タイトル、本文、公開日時）
--   announcement_reads   : ユーザーごとの既読状態。(announcement_id, user_id) で複合主キー
--
-- 権限:
--   announcements        : 全認証ユーザーが SELECT 可、サイトオーナーのみ INSERT/UPDATE/DELETE
--   announcement_reads   : 本人のみ SELECT/INSERT/DELETE
--
-- 未読判定はクライアントから:
--   SELECT * FROM announcements
--   LEFT JOIN announcement_reads ar
--     ON ar.announcement_id = id AND ar.user_id = auth.uid()
--   WHERE ar.user_id IS NULL ← これが未読
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

-- ========================================================================
-- 1. announcements テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_published_at
  ON public.announcements (published_at DESC);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS announcements_select ON public.announcements;
DROP POLICY IF EXISTS announcements_insert ON public.announcements;
DROP POLICY IF EXISTS announcements_update ON public.announcements;
DROP POLICY IF EXISTS announcements_delete ON public.announcements;

CREATE POLICY announcements_select ON public.announcements FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY announcements_insert ON public.announcements FOR INSERT
  TO authenticated
  WITH CHECK (public.is_site_owner());

CREATE POLICY announcements_update ON public.announcements FOR UPDATE
  TO authenticated
  USING (public.is_site_owner())
  WITH CHECK (public.is_site_owner());

CREATE POLICY announcements_delete ON public.announcements FOR DELETE
  TO authenticated
  USING (public.is_site_owner());

DROP TRIGGER IF EXISTS trg_announcements_touch ON public.announcements;
CREATE TRIGGER trg_announcements_touch
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- 2. announcement_reads テーブル（ユーザーごとの既読フラグ）
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS announcement_reads_select ON public.announcement_reads;
DROP POLICY IF EXISTS announcement_reads_insert ON public.announcement_reads;
DROP POLICY IF EXISTS announcement_reads_delete ON public.announcement_reads;

CREATE POLICY announcement_reads_select ON public.announcement_reads FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY announcement_reads_insert ON public.announcement_reads FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY announcement_reads_delete ON public.announcement_reads FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
