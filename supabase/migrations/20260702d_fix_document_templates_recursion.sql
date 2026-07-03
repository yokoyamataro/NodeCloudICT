-- 42P17: infinite recursion in policy for relation "document_templates"
--
-- 経緯:
--   document_templates.SELECT USING が document_template_shares を EXISTS で参照し、
--   document_template_shares.SELECT USING も document_templates を EXISTS で参照
--   していたため、両者の RLS 評価が相互再帰していた。Storage の shared_read も
--   同じ理由で再帰する。
--
-- 対策:
--   SECURITY DEFINER 関数（RLS バイパス）で「所有者判定」「共有先判定」「Storage
--   経由での参照可否」を行う。20260602 の is_project_owner と同じ設計。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

-- ========================================================================
-- 1. SECURITY DEFINER ヘルパー
-- ========================================================================
CREATE OR REPLACE FUNCTION public.is_document_template_owner(p_template_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_templates t
    WHERE t.id = p_template_id AND t.owner_user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_document_template_shared_with_me(p_template_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_template_shares s
    WHERE s.template_id = p_template_id
      AND s.shared_with_user_id = auth.uid()
  );
$$;

-- Storage: 指定パスのテンプレが自分に共有されているか？
CREATE OR REPLACE FUNCTION public.storage_can_read_template(p_storage_path text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.document_templates t
    JOIN public.document_template_shares s ON s.template_id = t.id
    WHERE t.storage_path = p_storage_path
      AND s.shared_with_user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_document_template_owner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_document_template_shared_with_me(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.storage_can_read_template(text) TO authenticated;

-- ========================================================================
-- 2. document_templates のポリシー再構築（SELECT のみ差し替え、他はそのまま）
-- ========================================================================
DROP POLICY IF EXISTS document_templates_select ON public.document_templates;

CREATE POLICY document_templates_select ON public.document_templates FOR SELECT
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR public.is_site_owner()
    OR public.is_document_template_shared_with_me(id)
  );

-- ========================================================================
-- 3. document_template_shares のポリシー再構築
-- ========================================================================
DROP POLICY IF EXISTS document_template_shares_select ON public.document_template_shares;
DROP POLICY IF EXISTS document_template_shares_write ON public.document_template_shares;

CREATE POLICY document_template_shares_select ON public.document_template_shares FOR SELECT
  TO authenticated
  USING (
    shared_with_user_id = auth.uid()
    OR public.is_site_owner()
    OR public.is_document_template_owner(template_id)
  );

CREATE POLICY document_template_shares_write ON public.document_template_shares FOR ALL
  TO authenticated
  USING (
    public.is_site_owner()
    OR public.is_document_template_owner(template_id)
  )
  WITH CHECK (
    public.is_site_owner()
    OR public.is_document_template_owner(template_id)
  );

-- ========================================================================
-- 4. Storage: 'templates' バケットの共有先 SELECT ポリシー差し替え
-- ========================================================================
DROP POLICY IF EXISTS templates_shared_read ON storage.objects;

CREATE POLICY templates_shared_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'templates'
    AND public.storage_can_read_template(storage.objects.name)
  );
