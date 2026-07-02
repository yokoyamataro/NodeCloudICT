-- 文書テンプレート機能: ユーザーが .docx をアップロードしテンプレートとして
-- 登録し、依頼人 / 隣接者 / 事務所情報などのデータを差し込んで出力する。
--
-- モデル:
--   document_templates       … テンプレのメタ（所有者、名前、Storage パス）
--   document_template_shares … 共有先ユーザー（多対多）
--   Storage bucket 'templates' … .docx 本体（{owner_uid}/{template_id}.docx）
--
-- RLS:
--   テンプレ SELECT: 所有者 or 共有先 or サイトオーナー
--   テンプレ INSERT/UPDATE/DELETE: 所有者 or サイトオーナー
--   共有: 所有者だけが編集可、共有先は自身の共有だけ SELECT 可
--   Storage: 所有者は自分の配下を自由に、共有先は SELECT のみ

-- ========================================================================
-- 1. テーブル
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  /** Storage 'templates' 内のオブジェクトキー。例: '{owner_uid}/{template_id}.docx' */
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_templates_owner
  ON public.document_templates (owner_user_id);

CREATE TABLE IF NOT EXISTS public.document_template_shares (
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  shared_with_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_document_template_shares_user
  ON public.document_template_shares (shared_with_user_id);

-- updated_at 自動更新
DROP TRIGGER IF EXISTS trg_document_templates_touch ON public.document_templates;
CREATE TRIGGER trg_document_templates_touch
  BEFORE UPDATE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ========================================================================
-- 2. RLS
-- ========================================================================
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_template_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_templates_select ON public.document_templates;
DROP POLICY IF EXISTS document_templates_insert ON public.document_templates;
DROP POLICY IF EXISTS document_templates_update ON public.document_templates;
DROP POLICY IF EXISTS document_templates_delete ON public.document_templates;

CREATE POLICY document_templates_select ON public.document_templates FOR SELECT
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.document_template_shares s
      WHERE s.template_id = document_templates.id
        AND s.shared_with_user_id = auth.uid()
    )
  );

CREATE POLICY document_templates_insert ON public.document_templates FOR INSERT
  TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY document_templates_update ON public.document_templates FOR UPDATE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_site_owner())
  WITH CHECK (owner_user_id = auth.uid() OR public.is_site_owner());

CREATE POLICY document_templates_delete ON public.document_templates FOR DELETE
  TO authenticated
  USING (owner_user_id = auth.uid() OR public.is_site_owner());

DROP POLICY IF EXISTS document_template_shares_select ON public.document_template_shares;
DROP POLICY IF EXISTS document_template_shares_write ON public.document_template_shares;

-- SELECT: 所有者・共有先本人・サイトオーナー
CREATE POLICY document_template_shares_select ON public.document_template_shares FOR SELECT
  TO authenticated
  USING (
    shared_with_user_id = auth.uid()
    OR public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.document_templates t
      WHERE t.id = document_template_shares.template_id
        AND t.owner_user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE は所有者かサイトオーナーのみ
CREATE POLICY document_template_shares_write ON public.document_template_shares FOR ALL
  TO authenticated
  USING (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.document_templates t
      WHERE t.id = document_template_shares.template_id
        AND t.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.document_templates t
      WHERE t.id = document_template_shares.template_id
        AND t.owner_user_id = auth.uid()
    )
  );

-- ========================================================================
-- 3. Storage: 'templates' バケット
-- ========================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'templates',
  'templates',
  false,
  10 * 1024 * 1024, -- 10MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS: `templates` バケットのオブジェクト用
DROP POLICY IF EXISTS templates_owner_all ON storage.objects;
DROP POLICY IF EXISTS templates_shared_read ON storage.objects;

-- 所有者は自分の {uid}/ 配下を自由に読み書き削除
CREATE POLICY templates_owner_all ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'templates'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'templates'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 共有先ユーザーは SELECT だけ可能（テーブルに share 行があるとき）
CREATE POLICY templates_shared_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'templates'
    AND EXISTS (
      SELECT 1
      FROM public.document_templates t
      JOIN public.document_template_shares s ON s.template_id = t.id
      WHERE t.storage_path = storage.objects.name
        AND s.shared_with_user_id = auth.uid()
    )
  );

-- ========================================================================
-- 4. サイトオーナー用 RPC: 全ユーザー一覧（共有先候補ドロップダウン用）
--    admin_list_users は既存だがサイトオーナー限定。一般ユーザーは自分の子ユーザーと、
--    サイトオーナーが自分に共有した相手など「知っているメール」を手打ちしてもらう
--    運用が現実的だが、共有先の指名を UI から補助するために「public.list_share_candidates()」
--    を用意する。
--
--    ここでは「同一組織のユーザー」を返す。組織なしの独立ユーザーには自身の親 /
--    子ユーザーのみを返す（プライバシー配慮）。
-- ========================================================================
CREATE OR REPLACE FUNCTION public.list_share_candidates()
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  RETURN QUERY
    SELECT DISTINCT u.id, u.email::text, p.full_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.user_id = u.id
    WHERE u.id <> caller
      AND (
        -- サイトオーナーなら全員
        public.is_site_owner()
        -- 同一組織
        OR EXISTS (
          SELECT 1 FROM public.profiles me
          WHERE me.user_id = caller
            AND me.organization_id IS NOT NULL
            AND me.organization_id = p.organization_id
        )
        -- 自分の親
        OR EXISTS (
          SELECT 1 FROM public.profiles me
          WHERE me.user_id = caller AND me.parent_user_id = u.id
        )
        -- 自分の子
        OR p.parent_user_id = caller
      )
    ORDER BY u.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_share_candidates() TO authenticated;
