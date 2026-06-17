-- design_coordinates.stake_status の既定値を 'unset' から '' (空 / 未指定) に変更。
-- 「未設置」と「未指定（まだ判断していない）」を別物として扱えるようにする。
--
-- 変更点:
--   1) CHECK 制約に '' (空) を追加。
--   2) DEFAULT を '' に変更。
--   3) 既存行の値はそのまま（'unset' のままで OK。空に書き換えは行わない）。
--
-- 何度流しても安全（冪等）。

ALTER TABLE public.design_coordinates
  DROP CONSTRAINT IF EXISTS design_coordinates_stake_status_check;

ALTER TABLE public.design_coordinates
  ALTER COLUMN stake_status SET DEFAULT '';

ALTER TABLE public.design_coordinates
  ADD CONSTRAINT design_coordinates_stake_status_check
  CHECK (
    stake_status IN (
      '',
      'unset',
      'temporary',
      'new',
      'replaced',
      'existing',
      'skip'
    )
  );

-- ついでに coordinate_type の既定も '' に変更。旧 'other' を引きずると
-- フィルタ/色割当て一覧に出てこないノイズ点種になるため。
-- 既存行はそのまま（必要なら別マイグレーションで一括書換え可能）。
ALTER TABLE public.design_coordinates
  ALTER COLUMN coordinate_type SET DEFAULT '';
