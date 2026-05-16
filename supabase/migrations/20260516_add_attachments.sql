-- 汎用添付（写真）テーブルとプライベート Storage バケット
--
-- 用途:
--   座標管理の各測点に対して 遠景/近景 など複数枚の写真を登録する。
--   将来的に 配管・工事区域・各工種 でも同じ仕組みを利用する想定。
--   写真はプロジェクトメンバーのみ閲覧/編集可。
--
-- 構成:
--   - public.attachments         …行メタ（パス・カテゴリ・撮影位置等）
--   - storage.buckets 'attachments' (private)
--     パス: {project_id}/{entity_type}/{entity_id}/{uuid}.jpg

-- ============================================================
-- 0. ヘルパ関数（冪等に再定義）
--    既に存在する環境でも CREATE OR REPLACE で安全に上書きできる。
--    storage.objects のポリシーから呼び出すため anon/authenticated にも EXECUTE を付与。
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_project_viewer(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_project_editor(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
      AND pm.role IN ('owner', 'editor')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_project_viewer(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_project_editor(uuid) TO authenticated, anon;

-- ============================================================
-- 1. attachments テーブル
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- 関連先エンティティ（例: 'coordinate' / 'pipe' / 'work_area'）
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  -- Storage 上のオブジェクトパス（バケット 'attachments' 内の相対パス）
  file_path TEXT NOT NULL,
  mime TEXT,
  byte_size INTEGER,
  -- 写真カテゴリ（'遠景' / '近景' / 任意ラベル）
  category TEXT,
  caption TEXT,
  taken_at TIMESTAMPTZ,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  exif JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity
  ON public.attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_project
  ON public.attachments(project_id);

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attachments_select" ON public.attachments;
DROP POLICY IF EXISTS "attachments_insert" ON public.attachments;
DROP POLICY IF EXISTS "attachments_update" ON public.attachments;
DROP POLICY IF EXISTS "attachments_delete" ON public.attachments;

CREATE POLICY "attachments_select" ON public.attachments
  FOR SELECT USING (public.is_project_viewer(project_id));
CREATE POLICY "attachments_insert" ON public.attachments
  FOR INSERT WITH CHECK (public.is_project_editor(project_id));
CREATE POLICY "attachments_update" ON public.attachments
  FOR UPDATE USING (public.is_project_editor(project_id));
CREATE POLICY "attachments_delete" ON public.attachments
  FOR DELETE USING (public.is_project_editor(project_id));

-- ============================================================
-- 2. Storage バケット（プライベート）
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', false)
ON CONFLICT (id) DO NOTHING;

-- パスの先頭セグメントを project_id として使用
-- 例: '11111111-2222-3333-4444-555555555555/coordinate/.../uuid.jpg'

DROP POLICY IF EXISTS "attachments_storage_select" ON storage.objects;
DROP POLICY IF EXISTS "attachments_storage_insert" ON storage.objects;
DROP POLICY IF EXISTS "attachments_storage_update" ON storage.objects;
DROP POLICY IF EXISTS "attachments_storage_delete" ON storage.objects;

CREATE POLICY "attachments_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'attachments'
    AND public.is_project_viewer(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "attachments_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'attachments'
    AND public.is_project_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "attachments_storage_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'attachments'
    AND public.is_project_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "attachments_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'attachments'
    AND public.is_project_editor(((storage.foldername(name))[1])::uuid)
  );
