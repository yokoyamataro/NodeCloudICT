-- mobility_positions の INSERT ポリシーを、圏外での遅延送信に対応させる。
--
-- 【問題】
-- 従来のポリシーは assignment が「乗車中 (ended_at IS NULL)」であることを
-- 要求していた:
--
--     AND a.ended_at IS NULL   -- 閉じた assignment には打てない
--
-- 端末が圏外だと ping はローカルキューに溜まる。現場に戻って降車したあとに
-- 通信が回復して送信すると、その時点で ended_at が入っているため RLS が
-- 42501 で拒否する。クライアントはこれを「永久に送れないエラー」と判定して
-- 該当 ping を破棄するので、**圏外区間の軌跡が丸ごと失われる**。
--
-- 山岳・海上はもちろん、トンネルや谷間を走る建設機械・ダンプでも起きる。
--
-- 【変更】
-- ended_at の条件を外し、代わりに recorded_at が乗車期間内であることを検査する。
-- これで「後から送る」ことは許しつつ、降車後に測った位置を捏造して差し込む
-- ことは防げる。
--
--   - 乗車中 (ended_at IS NULL): recorded_at >= started_at であればよい
--   - 降車済み: started_at <= recorded_at <= ended_at + 猶予
--
-- 猶予 (INTERVAL '5 minutes') は端末時刻のずれを吸収するため。NTP が効いて
-- いない端末でも数分はずれる。長くすると降車後の混入を許すので短めにする。
--
-- 未来の時刻も弾く (端末時計が大きく進んでいる場合の異常値対策)。
--
-- SELECT / UPDATE / DELETE のポリシーは変更しない。positions は引き続き
-- immutable (UPDATE/DELETE ポリシーを作らない = 全拒否)。

DROP POLICY IF EXISTS mobility_positions_insert ON public.mobility_positions;

CREATE POLICY mobility_positions_insert ON public.mobility_positions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_site_owner()
    OR EXISTS (
      SELECT 1 FROM public.vehicle_assignments a
      WHERE a.id = mobility_positions.assignment_id
        AND a.user_id = auth.uid()
        -- 乗車期間内に測った ping であること (送信が遅れるのは許す)
        AND mobility_positions.recorded_at >= a.started_at
        AND (
          a.ended_at IS NULL
          OR mobility_positions.recorded_at <= a.ended_at + INTERVAL '5 minutes'
        )
        -- 端末時計が進んでいる場合の異常値を弾く
        AND mobility_positions.recorded_at <= now() + INTERVAL '5 minutes'
    )
  );

COMMENT ON POLICY mobility_positions_insert ON public.mobility_positions IS
  '本人の assignment 宛で、かつ乗車期間内に測った ping のみ INSERT 可。'
  ' 降車後の遅延送信 (圏外キューの復帰時フラッシュ) を許すため ended_at IS NULL は要求しない。';
