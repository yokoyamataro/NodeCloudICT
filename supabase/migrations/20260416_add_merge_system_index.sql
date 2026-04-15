-- 集水合流タイプ用の接続先系統番号カラムを追加
-- Supabase SQL Editorで実行してください

-- ============================================
-- merge_system_indexカラムを追加
-- ============================================
ALTER TABLE pipe_wiring_rows
ADD COLUMN IF NOT EXISTS merge_system_index INTEGER DEFAULT NULL;

-- コメント
COMMENT ON COLUMN pipe_wiring_rows.merge_system_index IS '集水合流タイプ(collector_merge)の接続先系統番号';
