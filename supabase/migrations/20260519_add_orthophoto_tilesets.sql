-- ドローン等のオルソ画像タイル（z/x/y 形式）を保存・配信するためのテーブルと
-- 専用 Storage バケット。
-- 方式: クライアントで gdal2tiles 等によりタイル化したフォルダを直接アップロード
--       Storage バケットは public、パスは UUID で推測不可
--       (圃場座標と同じく「URL を知らない第三者には到達不能」モデル)

-- ================================================================
-- 0. ヘルパ関数（冪等に再定義）。Storage ポリシーから呼べるよう anon にも GRANT
-- ================================================================
CREATE OR REPLACE FUNCTION public.is_project_viewer(p_project_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_project_editor(p_project_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = p_project_id AND p.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id AND pm.user_id = auth.uid()
      AND pm.role IN ('owner', 'editor')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_farm_viewer(p_farm_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farms f
    WHERE f.id = p_farm_id
      AND (f.user_id = auth.uid() OR public.is_project_viewer(f.project_id))
  );
$$;

CREATE OR REPLACE FUNCTION public.is_farm_editor(p_farm_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farms f
    WHERE f.id = p_farm_id
      AND (f.user_id = auth.uid() OR public.is_project_editor(f.project_id))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_project_viewer(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_project_editor(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_farm_viewer(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_farm_editor(uuid) TO authenticated, anon;

CREATE TABLE IF NOT EXISTS public.orthophoto_tilesets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Storage パスの先頭部分。実タイルは {storage_path}/{z}/{x}/{y}.png に配置
  storage_path TEXT NOT NULL,
  min_zoom INT NOT NULL DEFAULT 0,
  max_zoom INT NOT NULL DEFAULT 22,
  bounds_north DOUBLE PRECISION NOT NULL,
  bounds_south DOUBLE PRECISION NOT NULL,
  bounds_east DOUBLE PRECISION NOT NULL,
  bounds_west DOUBLE PRECISION NOT NULL,
  tile_format TEXT NOT NULL DEFAULT 'png',
  -- 既定の表示透過度（0..1）
  opacity DOUBLE PRECISION NOT NULL DEFAULT 0.85,
  -- 既定で起動時に有効にするか
  enabled_by_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orthophoto_tilesets_farm_id ON public.orthophoto_tilesets(farm_id);

-- updated_at 自動更新
DROP TRIGGER IF EXISTS update_orthophoto_tilesets_updated_at ON public.orthophoto_tilesets;
CREATE TRIGGER update_orthophoto_tilesets_updated_at
  BEFORE UPDATE ON public.orthophoto_tilesets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- メンバー方式 RLS
ALTER TABLE public.orthophoto_tilesets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orthophoto_tilesets_select" ON public.orthophoto_tilesets;
DROP POLICY IF EXISTS "orthophoto_tilesets_insert" ON public.orthophoto_tilesets;
DROP POLICY IF EXISTS "orthophoto_tilesets_update" ON public.orthophoto_tilesets;
DROP POLICY IF EXISTS "orthophoto_tilesets_delete" ON public.orthophoto_tilesets;

CREATE POLICY "orthophoto_tilesets_select" ON public.orthophoto_tilesets
  FOR SELECT USING (public.is_farm_viewer(farm_id));
CREATE POLICY "orthophoto_tilesets_insert" ON public.orthophoto_tilesets
  FOR INSERT WITH CHECK (public.is_farm_editor(farm_id));
CREATE POLICY "orthophoto_tilesets_update" ON public.orthophoto_tilesets
  FOR UPDATE USING (public.is_farm_editor(farm_id));
CREATE POLICY "orthophoto_tilesets_delete" ON public.orthophoto_tilesets
  FOR DELETE USING (public.is_farm_editor(farm_id));

-- ================================================================
-- Storage バケット（public）
-- ================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('orthophoto-tiles', 'orthophoto-tiles', true)
ON CONFLICT (id) DO NOTHING;

-- パス: {farm_id}/{tileset_id}/{z}/{x}/{y}.png
-- 閲覧は公開（バケット public）。書き込みは「ログイン済みユーザー」に許可する。
--   ※ storage.foldername(name)[1]::uuid によるパス先頭=farm_id 判定は環境により
--     不安定（RLS 違反になる）ため、シンプルにバケット単位の許可とする。
--     どの工区のメタかは orthophoto_tilesets テーブル側の RLS で制御される。

DROP POLICY IF EXISTS "orthophoto_tiles_insert" ON storage.objects;
DROP POLICY IF EXISTS "orthophoto_tiles_update" ON storage.objects;
DROP POLICY IF EXISTS "orthophoto_tiles_delete" ON storage.objects;

CREATE POLICY "orthophoto_tiles_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'orthophoto-tiles');

CREATE POLICY "orthophoto_tiles_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'orthophoto-tiles');

CREATE POLICY "orthophoto_tiles_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'orthophoto-tiles');
