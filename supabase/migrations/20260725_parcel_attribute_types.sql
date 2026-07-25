-- 地番属性 (対象地 / 隣接地 / 道路 / 河川 / その他 / ユーザー任意) をプロジェクトごとに
-- 定義できるようにする。
--
-- design/UX 方針:
--   ・attribute は「未選択」を許容 (parcels.attribute_code IS NULL)
--   ・組み込み属性 (target/adjacent/road/river/other) は自動 seed され、削除不可
--   ・color は #rrggbb 形式で保存。地図の polygon fillColor に使う
--   ・ユーザーが任意コード (code) を追加できる。code はプロジェクト内で UNIQUE
--   ・code は表示せず label だけを見せる。sort_order で並び順を決定

CREATE TABLE IF NOT EXISTS public.parcel_attribute_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,  -- '#rrggbb' 形式
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_builtin BOOLEAN NOT NULL DEFAULT false,  -- 組み込みは削除不可 (label/color は編集可)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE INDEX IF NOT EXISTS idx_parcel_attribute_types_project_id
  ON public.parcel_attribute_types(project_id);

-- updated_at 自動更新
DROP TRIGGER IF EXISTS update_parcel_attribute_types_updated_at ON public.parcel_attribute_types;
CREATE TRIGGER update_parcel_attribute_types_updated_at
  BEFORE UPDATE ON public.parcel_attribute_types
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS: プロジェクトメンバー方式
ALTER TABLE public.parcel_attribute_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parcel_attribute_types_select" ON public.parcel_attribute_types;
DROP POLICY IF EXISTS "parcel_attribute_types_insert" ON public.parcel_attribute_types;
DROP POLICY IF EXISTS "parcel_attribute_types_update" ON public.parcel_attribute_types;
DROP POLICY IF EXISTS "parcel_attribute_types_delete" ON public.parcel_attribute_types;

CREATE POLICY "parcel_attribute_types_select" ON public.parcel_attribute_types
  FOR SELECT USING (public.is_project_viewer(project_id));

CREATE POLICY "parcel_attribute_types_insert" ON public.parcel_attribute_types
  FOR INSERT WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY "parcel_attribute_types_update" ON public.parcel_attribute_types
  FOR UPDATE USING (public.is_project_editor(project_id));

CREATE POLICY "parcel_attribute_types_delete" ON public.parcel_attribute_types
  FOR DELETE USING (public.is_project_editor(project_id) AND is_builtin = false);

-- ============================================================
-- parcels.attribute_code (未選択=NULL) を追加
-- ============================================================
ALTER TABLE public.parcels
  ADD COLUMN IF NOT EXISTS attribute_code TEXT;

COMMENT ON COLUMN public.parcels.attribute_code IS
  '地番の属性コード (対象地=target / 隣接地=adjacent / 道路=road / 河川=river / その他=other, または任意コード)。NULL=未選択';

-- ============================================================
-- 組み込み属性の seed (プロジェクトごとに 5 種類を挿入)
-- ============================================================
-- 冪等: 既に code が存在する project にはスキップ (ON CONFLICT DO NOTHING)。
-- 新規プロジェクト作成時にも同じ seed を掛けるトリガを設ける。

CREATE OR REPLACE FUNCTION public.seed_parcel_attribute_types(p_project_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.parcel_attribute_types (project_id, code, label, color, sort_order, is_builtin)
  VALUES
    (p_project_id, 'target',   '対象地',  '#ef4444', 10, true),  -- 赤
    (p_project_id, 'adjacent', '隣接地',  '#eab308', 20, true),  -- 黄
    (p_project_id, 'road',     '道路',    '#94a3b8', 30, true),  -- グレー
    (p_project_id, 'river',    '河川',    '#3b82f6', 40, true),  -- 青
    (p_project_id, 'other',    'その他',  '#a855f7', 50, true)   -- 紫 (指示無しなので任意)
  ON CONFLICT (project_id, code) DO NOTHING;
$$;

-- 既存の全プロジェクトに seed
DO $$
DECLARE
  proj RECORD;
BEGIN
  FOR proj IN SELECT id FROM public.projects WHERE deleted_at IS NULL LOOP
    PERFORM public.seed_parcel_attribute_types(proj.id);
  END LOOP;
END $$;

-- 新規プロジェクト作成時にも自動 seed
CREATE OR REPLACE FUNCTION public.trg_projects_seed_parcel_attributes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM public.seed_parcel_attribute_types(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_seed_parcel_attributes ON public.projects;
CREATE TRIGGER projects_seed_parcel_attributes
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_projects_seed_parcel_attributes();
