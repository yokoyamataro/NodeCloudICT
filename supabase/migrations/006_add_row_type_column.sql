-- 管路設定行テーブルにタイプカラムを追加
-- Supabase SQL Editorで実行してください

-- ============================================
-- 行タイプカラムを追加
-- ============================================
ALTER TABLE pipe_wiring_rows
ADD COLUMN IF NOT EXISTS row_type TEXT DEFAULT NULL;

-- コメント
COMMENT ON COLUMN pipe_wiring_rows.row_type IS '行タイプ: absorption_end(吸水端部), absorption_merge(吸水合流), collector_merge(集水合流), collector_change(集水変化点), collector_junction(集水合流点), outlet(落口)';
