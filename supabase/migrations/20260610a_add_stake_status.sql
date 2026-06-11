-- design_coordinates に「設置状態」列を追加（地籍測量の杭設置ワークフロー管理）。
--
-- 値:
--   'none'        : なし（デフォルト）
--   'needed'      : 要設置
--   'temporary'   : 仮杭設置
--   'permanent'   : 本杭設置
--   'existing'    : 既設採用
--   'impossible'  : 設置不可

ALTER TABLE public.design_coordinates
  ADD COLUMN IF NOT EXISTS stake_status text NOT NULL DEFAULT 'none';

ALTER TABLE public.design_coordinates
  DROP CONSTRAINT IF EXISTS design_coordinates_stake_status_check;

ALTER TABLE public.design_coordinates
  ADD CONSTRAINT design_coordinates_stake_status_check
  CHECK (
    stake_status IN (
      'none',
      'needed',
      'temporary',
      'permanent',
      'existing',
      'impossible'
    )
  );
