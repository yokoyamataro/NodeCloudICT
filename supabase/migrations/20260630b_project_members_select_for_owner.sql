-- project_members の SELECT ポリシーを拡張: プロジェクト作成者・サイトオーナー・
-- role='owner' メンバーも、他のメンバー行を SELECT できるようにする。
--
-- 経緯:
--   PostgREST の `.delete().select()` / `.update().select()` は内部的に
--   DELETE/UPDATE ... RETURNING * を生成する。PostgreSQL の RLS では
--   USING で削除/更新を許可しても、RETURNING で返される行は SELECT ポリシー
--   による絞り込みを受ける。
--
--   従来 project_members_select は user_id = auth.uid() のみだったため、
--   サイトオーナーが他人のメンバー行を消すと「削除自体は成功・RETURNING は空」
--   となり、フロントの 0 行ガードが「削除できません」と誤って表示していた。
--   UPDATE（権限変更）も同じ症状で「変えても 0 行なのでエラー」と出ていた。
--
-- 方針:
--   project_members_select の USING に is_project_owner(project_id) を OR で追加。
--   is_project_owner は SECURITY DEFINER で project_members を参照するため、
--   過去問題になっていた 42P17（RLS 再帰）は発生しない。
--
-- 適用方法: Supabase Dashboard → SQL Editor で実行（冪等）。

DROP POLICY IF EXISTS "project_members_select" ON public.project_members;

CREATE POLICY "project_members_select" ON public.project_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_project_owner(project_id)
  );
