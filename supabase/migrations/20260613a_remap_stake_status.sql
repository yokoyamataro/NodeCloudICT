-- design_coordinates.stake_status の値体系を刷新する。
--
-- 旧 → 新 マッピング:
--   none       → unset       （未設置）
--   needed     → unset       （未設置）
--   temporary  → temporary   （仮杭）
--   permanent  → new         （新設）
--   existing   → existing    （既設）
--   impossible → skip        （不設置）
--
-- 新しい値は:
--   unset / temporary / new / replaced / existing / skip
-- 既定は 'unset'。
--
-- 何度流しても安全になるよう、UPDATE は新コードを上書きしない条件で行い、
-- CHECK 制約は付け直す。default も新値に切替える。

-- 1) CHECK 制約を一旦外す（古い値を新値に置き換える前に必須）
ALTER TABLE public.design_coordinates
  DROP CONSTRAINT IF EXISTS design_coordinates_stake_status_check;

-- 2) 旧コードを新コードへ書き換え
UPDATE public.design_coordinates
   SET stake_status = 'unset'
 WHERE stake_status IN ('none', 'needed');

UPDATE public.design_coordinates
   SET stake_status = 'new'
 WHERE stake_status = 'permanent';

UPDATE public.design_coordinates
   SET stake_status = 'skip'
 WHERE stake_status = 'impossible';

-- 3) 想定外の値が残っていれば 'unset' に倒す（CHECK 適用前の安全網）
UPDATE public.design_coordinates
   SET stake_status = 'unset'
 WHERE stake_status NOT IN ('unset', 'temporary', 'new', 'replaced', 'existing', 'skip');

-- 4) default を新値に切替
ALTER TABLE public.design_coordinates
  ALTER COLUMN stake_status SET DEFAULT 'unset';

-- 5) 新しい CHECK 制約を付け直す
ALTER TABLE public.design_coordinates
  ADD CONSTRAINT design_coordinates_stake_status_check
  CHECK (
    stake_status IN (
      'unset',
      'temporary',
      'new',
      'replaced',
      'existing',
      'skip'
    )
  );
