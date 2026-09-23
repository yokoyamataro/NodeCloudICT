-- 1 路線 に 複数 の 縦断 を 持てる ように する。
--
-- 中心線 の 縦断 (杭打ち・中心設計高・エクスポート が 使う 主縦断) は
-- 従来 どおり open_channels.profile_points。 こちら は それ と 別 に、
-- 管理 の ため に 並べて 見たい 縦断 を 名前 付き で 保持 する。
--   例) 道路高 と 側溝高 / 河床高 と 左築堤高・右築堤高
--
-- 形: [{ id, name, color, points: [{ distance, floorHeight, vcl }] }]
--   - id     : クライアント 生成 の 一意 文字列
--   - name   : 表示名 (道路高 など)
--   - color  : 縦断図 の 線 の 色 (省略 可。 省略 時 は 並び 順 の 既定色)
--   - points : 主縦断 と 同じ 変化点 の 形式
--
-- 主縦断 と 違い、 測点 の 中心設計高 / 杭打ち / エクスポート に は 影響 しない
-- (表示 と 管理 だけ)。 その ため 既存 データ と モバイル は 無修正 で 動く。

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS extra_profiles JSONB NOT NULL DEFAULT '[]'::jsonb;
