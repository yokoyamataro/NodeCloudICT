-- 実測記録 (staking_records) 同士 を 対称 に ペアリング する ため の 自己参照カラム。
-- 設計座標 に リンク されて いない (target_type='free' 等) 記録同士 を 「実測1 / 実測2」
-- として 束ねる 用途。設計座標 リンク済み の 記録 は target_ref_id を 使う。
--
-- 対称性:
--   A.paired_with_id = B.id  かつ  B.paired_with_id = A.id
-- アプリ側 の pairRecords / unpairRecord で 二 レコード 同時 に 更新 する。
--
-- ON DELETE SET NULL: ペア相手 が 削除 されたら 自身 の paired_with_id を NULL に。
ALTER TABLE staking_records
  ADD COLUMN IF NOT EXISTS paired_with_id UUID
    REFERENCES staking_records(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staking_records_paired_with_id
  ON staking_records(paired_with_id);
