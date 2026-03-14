-- 施工計画テーブルに系統カラムを追加
-- Supabase SQL Editorで実行してください

-- ============================================
-- 系統情報カラムを追加
-- ============================================
ALTER TABLE construction_plan_rows
ADD COLUMN IF NOT EXISTS system_index INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS is_system_end BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS system_end_type TEXT DEFAULT NULL;

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_construction_plan_rows_system
  ON construction_plan_rows(project_id, group_type, group_index, system_index);
