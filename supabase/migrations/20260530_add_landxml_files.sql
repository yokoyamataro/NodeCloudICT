-- LandXML ファイルを工区ごとに Supabase Storage で保管する。
-- メタデータ: public.landxml_files
-- 実体     : storage バケット 'landxml' 配下、パスは '<farmId>/<uuid>.xml'
--
-- 設計:
--   * 同じ工区 + 同じ kind は active=true を 1 件だけ許す。新しいファイルが
--     active で入ったら古い active は false にする（アプリ側で実装）。
--   * 履歴は削除しない（active=false で残る）。
--   * RLS: 工区メンバー（is_farm_viewer / is_farm_editor）にだけ可。
--
-- Supabase SQL Editor で実行してください。

-- ============================================================
-- 1. メタデータテーブル
-- ============================================================

CREATE TABLE IF NOT EXISTS public.landxml_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                -- 元のファイル名（表示用）
  storage_path TEXT NOT NULL,        -- バケット内パス '<farmId>/<uuid>.xml'
  size_bytes BIGINT,
  kind TEXT NOT NULL DEFAULT 'design', -- 'design' / 'trench'（床掘） / 'ground'（現況）など
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landxml_files_farm ON public.landxml_files(farm_id);
CREATE INDEX IF NOT EXISTS idx_landxml_files_active
  ON public.landxml_files(farm_id, kind) WHERE is_active;

-- INSERT/UPDATE で created_by/updated_by/updated_at を自動セット
CREATE OR REPLACE FUNCTION public.set_landxml_files_audit_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  IF NEW.updated_by IS NULL THEN NEW.updated_by := auth.uid(); END IF;
  NEW.updated_at := now();
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_landxml_files_audit_insert ON public.landxml_files;
CREATE TRIGGER trg_landxml_files_audit_insert
  BEFORE INSERT ON public.landxml_files
  FOR EACH ROW EXECUTE FUNCTION public.set_landxml_files_audit_insert();

CREATE OR REPLACE FUNCTION public.set_landxml_files_audit_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  NEW.updated_at := now();
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_landxml_files_audit_update ON public.landxml_files;
CREATE TRIGGER trg_landxml_files_audit_update
  BEFORE UPDATE ON public.landxml_files
  FOR EACH ROW EXECUTE FUNCTION public.set_landxml_files_audit_update();

-- RLS: 工区メンバーのみアクセス可
ALTER TABLE public.landxml_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "landxml_files_select" ON public.landxml_files;
DROP POLICY IF EXISTS "landxml_files_insert" ON public.landxml_files;
DROP POLICY IF EXISTS "landxml_files_update" ON public.landxml_files;
DROP POLICY IF EXISTS "landxml_files_delete" ON public.landxml_files;

CREATE POLICY "landxml_files_select" ON public.landxml_files
  FOR SELECT TO authenticated
  USING (public.is_farm_viewer(farm_id));
CREATE POLICY "landxml_files_insert" ON public.landxml_files
  FOR INSERT TO authenticated
  WITH CHECK (public.is_farm_editor(farm_id));
CREATE POLICY "landxml_files_update" ON public.landxml_files
  FOR UPDATE TO authenticated
  USING (public.is_farm_editor(farm_id));
CREATE POLICY "landxml_files_delete" ON public.landxml_files
  FOR DELETE TO authenticated
  USING (public.is_farm_editor(farm_id));

-- ============================================================
-- 2. Storage バケット（プライベート）
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('landxml', 'landxml', false)
ON CONFLICT (id) DO NOTHING;

-- パス先頭セグメントを farm_id として使用: '<farmId>/<uuid>.xml'

DROP POLICY IF EXISTS "landxml_storage_select" ON storage.objects;
DROP POLICY IF EXISTS "landxml_storage_insert" ON storage.objects;
DROP POLICY IF EXISTS "landxml_storage_update" ON storage.objects;
DROP POLICY IF EXISTS "landxml_storage_delete" ON storage.objects;

CREATE POLICY "landxml_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'landxml'
    AND public.is_farm_viewer(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "landxml_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'landxml'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "landxml_storage_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'landxml'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "landxml_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'landxml'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );
