-- parcels に「都道府県」「郡町村」を追加。
-- 既存の parcels.location は「字名」(例: 「青葉町」「朝日町一丁目」) を保持し続ける。
-- 表示は「郡町村 + 字名」(例: 「斜里郡斜里町青葉町」)、
-- 都道府県は各所で分離入力しやすいよう別列で保持する (touki.or.jp API 送信時に別値なので)。
--
-- 既存行は NULL のまま。取込時 or 登記取得モーダルから逐次埋める運用。

ALTER TABLE public.parcels
  ADD COLUMN IF NOT EXISTS prefecture text,
  ADD COLUMN IF NOT EXISTS municipality text;

COMMENT ON COLUMN public.parcels.prefecture IS
  '都道府県名 (例: 北海道、山形県)。表示時は非表示、touki.or.jp 送信時に使用。';
COMMENT ON COLUMN public.parcels.municipality IS
  '郡町村名 (例: 斜里郡斜里町、鶴岡市)。地番管理の表では location と連結して表示。';
