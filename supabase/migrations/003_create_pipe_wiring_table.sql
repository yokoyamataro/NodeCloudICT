-- 管路設定テーブル作成
-- Supabase SQL Editorで実行してください

-- ============================================
-- 1. 管路設定テーブル（配線グループ）
-- ============================================
CREATE TABLE IF NOT EXISTS pipe_wiring_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  group_type TEXT NOT NULL, -- 'collector' or 'direct'
  name TEXT NOT NULL, -- グループ名（例：集水暗渠1、直落暗渠）
  sort_order INTEGER NOT NULL DEFAULT 0, -- 表示順序
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_pipe_wiring_groups_project ON pipe_wiring_groups(project_id);
CREATE INDEX idx_pipe_wiring_groups_sort ON pipe_wiring_groups(project_id, sort_order);

-- RLS有効化
ALTER TABLE pipe_wiring_groups ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access pipe_wiring_groups via project"
  ON pipe_wiring_groups FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM design_projects
      WHERE design_projects.id = pipe_wiring_groups.project_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 2. 管路設定行テーブル（各行のデータ）
-- ============================================
CREATE TABLE IF NOT EXISTS pipe_wiring_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES pipe_wiring_groups(id) ON DELETE CASCADE,
  absorption_pipe_ids UUID[] NOT NULL DEFAULT '{}', -- 吸水管路IDリスト
  collector_pipe_id UUID, -- 集水/落口管路ID
  is_merge_pipe BOOLEAN NOT NULL DEFAULT false, -- 集水合流管フラグ
  sort_order INTEGER NOT NULL DEFAULT 0, -- 表示順序
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX idx_pipe_wiring_rows_group ON pipe_wiring_rows(group_id);
CREATE INDEX idx_pipe_wiring_rows_sort ON pipe_wiring_rows(group_id, sort_order);

-- RLS有効化
ALTER TABLE pipe_wiring_rows ENABLE ROW LEVEL SECURITY;

-- ポリシー
CREATE POLICY "Users can access pipe_wiring_rows via group"
  ON pipe_wiring_rows FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM pipe_wiring_groups
      JOIN design_projects ON design_projects.id = pipe_wiring_groups.project_id
      WHERE pipe_wiring_groups.id = pipe_wiring_rows.group_id
      AND design_projects.user_id = auth.uid()
    )
  );

-- ============================================
-- 3. 更新日時自動更新トリガー
-- ============================================
CREATE TRIGGER update_pipe_wiring_groups_updated_at
  BEFORE UPDATE ON pipe_wiring_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_pipe_wiring_rows_updated_at
  BEFORE UPDATE ON pipe_wiring_rows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
