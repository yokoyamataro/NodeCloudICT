-- ============================================================
-- 地権者管理 (landowners) の属性 / 本人確認方法 列を追加
--
-- 追加列:
--   attribute            : 属性 (申請人 / 隣接者 等)
--   id_method            : 本人 (地権者) の本人確認方法
--                          ('license' / 'idcard' / 'meishiki' / 'other')
--   id_method_other      : 上記 'other' 選択時の 自由文
--   agent_id_method      : 立会人 (代理人) の本人確認方法
--   agent_id_method_other: 同上 'other' の自由文
--
-- いずれも既存行への 影響を避けるため nullable。
-- ============================================================

ALTER TABLE public.landowners
  ADD COLUMN IF NOT EXISTS attribute text,
  ADD COLUMN IF NOT EXISTS id_method text,
  ADD COLUMN IF NOT EXISTS id_method_other text,
  ADD COLUMN IF NOT EXISTS agent_id_method text,
  ADD COLUMN IF NOT EXISTS agent_id_method_other text;

-- attribute の 想定値 (制約ではなくコメント):
--   'applicant' : 申請人
--   'adjacent'  : 隣接者
COMMENT ON COLUMN public.landowners.attribute IS
  '地権者の属性: applicant=申請人, adjacent=隣接者 (自由文だが UI では選択式)';
COMMENT ON COLUMN public.landowners.id_method IS
  '本人 (地権者) の本人確認方法: license/idcard/meishiki/other';
COMMENT ON COLUMN public.landowners.agent_id_method IS
  '立会人 (代理人) の本人確認方法: license/idcard/meishiki/other';
