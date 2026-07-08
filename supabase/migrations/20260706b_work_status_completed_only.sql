-- farm_work_status を「完了 / 未完了」の 2 値に単純化する。
--
-- 経緯:
--   未着手 / 進行中 / 完了 の 3 状態は運用で使い分けが煩雑になったため、
--   完了 (True/False) だけで管理する方針に変更した。
--
-- 対応:
--   既存の 'in_progress' 行は 'not_started' へ差し替えて、"未完了" として扱う。
--   'completed' は現状のまま維持する。
--   CHECK 制約は付けないので、今後もし別値が入れられても壊れないが、
--   アプリ側の型では 2 値だけを扱う。

UPDATE public.farm_work_status
   SET status = 'not_started'
 WHERE status = 'in_progress';
