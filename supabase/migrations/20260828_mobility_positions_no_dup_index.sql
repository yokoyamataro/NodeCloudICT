-- mobility_positions の重複防止インデックスを、リポジトリの履歴に載せる。
--
-- 本番 DB には既に存在している (直接作成されたもの):
--   CREATE UNIQUE INDEX uidx_mobility_positions_no_dup
--     ON public.mobility_positions USING btree (assignment_id, recorded_at)
--
-- マイグレーションに無いと、他の環境で DB を作り直したときに同じ制約が再現されず、
-- 圏外キューの再送で ping が二重に入る。IF NOT EXISTS なので本番に流しても無害。
--
-- クライアント側 (mobilityStore.sendPositions) は、この制約を前提に
-- upsert(onConflict: 'assignment_id,recorded_at', ignoreDuplicates: true)
-- で送る。insert だとバッチ内に送信済みが 1 件でも混ざるとバッチ全体が 23505 で
-- 落ち、キューが永久に詰まる。

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mobility_positions_no_dup
  ON public.mobility_positions USING btree (assignment_id, recorded_at);

COMMENT ON INDEX public.uidx_mobility_positions_no_dup IS
  '同一 assignment 内で recorded_at が重複する ping を弾く。'
  ' 圏外キューの再送で二重登録されるのを防ぐ。';
