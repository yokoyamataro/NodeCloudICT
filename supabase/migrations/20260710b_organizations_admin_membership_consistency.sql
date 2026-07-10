-- organizations.admin_user_id が「その組織に所属するユーザー」であることを保証する。
--
-- 経緯:
--   ユーザーは profiles.organization_id で組織に所属し、組織は
--   organizations.admin_user_id で管理者を指す双方向参照になっている。
--   参照方向が独立しているため、次のような不整合が起きうる:
--     ・組織 A の管理者に、profile.organization_id = B のユーザーを設定できる
--     ・管理者ユーザーの profile.organization_id を変更しても、組織 A の
--       admin_user_id は残ったままで孤立参照になる
--
-- 対策 (2 つのトリガーで実装):
--   1. organizations の admin_user_id を書き込むとき、そのユーザーが
--      profile.organization_id = organizations.id を満たすことをチェックする。
--   2. profiles.organization_id が変更されたら、旧組織で自分が管理者だった場合、
--      その organizations.admin_user_id を自動で NULL に戻す。

-- ========================================================================
-- 1. organizations.admin_user_id の所属チェック
-- ========================================================================
CREATE OR REPLACE FUNCTION public.validate_org_admin_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.admin_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = NEW.admin_user_id
        AND p.organization_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        '管理者に指定できるのは、その組織 (%) に所属するユーザーのみです',
        NEW.name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organizations_validate_admin ON public.organizations;
CREATE TRIGGER trg_organizations_validate_admin
  BEFORE INSERT OR UPDATE OF admin_user_id ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.validate_org_admin_membership();

-- ========================================================================
-- 2. profile.organization_id 変更時に旧組織の管理者フラグを自動クリア
-- ========================================================================
CREATE OR REPLACE FUNCTION public.clear_admin_on_profile_org_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
     AND OLD.organization_id IS NOT NULL THEN
    UPDATE public.organizations
      SET admin_user_id = NULL
      WHERE id = OLD.organization_id
        AND admin_user_id = OLD.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_clear_admin_on_org_change ON public.profiles;
CREATE TRIGGER trg_profiles_clear_admin_on_org_change
  AFTER UPDATE OF organization_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.clear_admin_on_profile_org_change();

-- ========================================================================
-- 3. 既存の不整合データを掃除 (念のため)
--    このマイグレーション適用前に既に admin_user_id が矛盾している行があれば
--    NULL に戻す。運用データがまだ少ない前提。
-- ========================================================================
UPDATE public.organizations o
  SET admin_user_id = NULL
  WHERE admin_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = o.admin_user_id
        AND p.organization_id = o.id
    );
