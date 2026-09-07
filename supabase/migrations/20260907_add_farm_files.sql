-- 工区ごとの ファイルストレージ。
-- メタデータ: public.farm_files
-- 実体     : storage バケット 'farm-files' 配下、パスは '<farmId>/<uuid>.<ext>'
--
-- 扱う 種類: PDF / SFC / P21 / DXF / LandXML / SIM
--   (SFC / P21 は 保存と 受け渡しのみ。画面での 閲覧は 未実装)
--
-- 制限:
--   * 1 工区 20MB まで。超える アップロードは アプリ側で 弾く +
--     ここでも トリガで 二重に 止める (別端末からの 同時アップロード対策)
--   * アップロードから 3 ヶ月で 期限切れ。expires_at に 入れておき、
--     一覧では 期限切れを 除外する。実体の 削除は 別途 バッチで 行う
--     (プランで 期間を 変える 想定なので、期間は 行ごとに 持たせる)
--
-- Supabase SQL Editor で実行してください。

-- ============================================================
-- 1. メタデータテーブル
-- ============================================================

CREATE TABLE IF NOT EXISTS public.farm_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- 元のファイル名 (表示用)
  storage_path TEXT NOT NULL,         -- バケット内パス '<farmId>/<uuid>.<ext>'
  size_bytes BIGINT NOT NULL,
  -- 拡張子から 決まる 種別。判定は アプリ側、ここは 記録用
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'sfc', 'p21', 'dxf', 'landxml', 'sim')),
  notes TEXT,
  -- アップロードから 3 ヶ月。プランで 変える 想定なので 行ごとに 持つ
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '3 months'),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_farm_files_farm ON public.farm_files(farm_id);
CREATE INDEX IF NOT EXISTS idx_farm_files_expires ON public.farm_files(expires_at);

-- ============================================================
-- 2. 容量上限 (1 工区 20MB)
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_farm_files_quota()
RETURNS TRIGGER AS $$
DECLARE
  total BIGINT;
  limit_bytes CONSTANT BIGINT := 20 * 1024 * 1024;
BEGIN
  SELECT COALESCE(SUM(size_bytes), 0) INTO total
  FROM public.farm_files
  WHERE farm_id = NEW.farm_id AND expires_at > now();

  IF total + NEW.size_bytes > limit_bytes THEN
    RAISE EXCEPTION
      '工区の容量上限 (20MB) を超えます。使用中 % バイト / 追加 % バイト',
      total, NEW.size_bytes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_farm_files_quota ON public.farm_files;
CREATE TRIGGER trg_farm_files_quota
  BEFORE INSERT ON public.farm_files
  FOR EACH ROW EXECUTE FUNCTION public.check_farm_files_quota();

-- created_by / created_at の 自動セット
CREATE OR REPLACE FUNCTION public.set_farm_files_audit_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_farm_files_audit_insert ON public.farm_files;
CREATE TRIGGER trg_farm_files_audit_insert
  BEFORE INSERT ON public.farm_files
  FOR EACH ROW EXECUTE FUNCTION public.set_farm_files_audit_insert();

-- ============================================================
-- 3. RLS: 工区メンバーのみ
-- ============================================================

ALTER TABLE public.farm_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "farm_files_select" ON public.farm_files;
DROP POLICY IF EXISTS "farm_files_insert" ON public.farm_files;
DROP POLICY IF EXISTS "farm_files_delete" ON public.farm_files;

CREATE POLICY "farm_files_select" ON public.farm_files
  FOR SELECT TO authenticated
  USING (public.is_farm_viewer(farm_id));
CREATE POLICY "farm_files_insert" ON public.farm_files
  FOR INSERT TO authenticated
  WITH CHECK (public.is_farm_editor(farm_id));
CREATE POLICY "farm_files_delete" ON public.farm_files
  FOR DELETE TO authenticated
  USING (public.is_farm_editor(farm_id));

-- ============================================================
-- 4. Storage バケット (プライベート)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('farm-files', 'farm-files', false)
ON CONFLICT (id) DO NOTHING;

-- パス先頭セグメントを farm_id として使用: '<farmId>/<uuid>.<ext>'

DROP POLICY IF EXISTS "farm_files_storage_select" ON storage.objects;
DROP POLICY IF EXISTS "farm_files_storage_insert" ON storage.objects;
DROP POLICY IF EXISTS "farm_files_storage_delete" ON storage.objects;

CREATE POLICY "farm_files_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'farm-files'
    AND public.is_farm_viewer(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "farm_files_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'farm-files'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "farm_files_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'farm-files'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );
