-- 標準断面 を 名前 付き で 複数 持てる ように する。
--
-- 従来 は open_channels.standard_cross_section に 1 路線 1 つ だけ だった。
-- 現場 で は 「台形水路 B=1.0 H=1.2」「道路部 W=4.0」 の ように 何種類 か を
-- 使い分ける ので、 名前 を 付けて 並べ、 測点 ごと に 選んで 取り込める ように する。
--
-- 形: [{ id, name, note, cross: { left: [...], right: [...] } }]
--   - id    : クライアント 生成 の 一意 文字列
--   - name  : 表示名 (台形水路 B=1.0 H=1.2 など)
--   - note  : 補足 (省略 可)
--   - cross : StandardCrossSection。 中心 から 外 向き の 区間列 を 左右 に 持つ
--
-- standard_cross_section は そのまま 残す。 既存 の 参照
-- (計画 を 開いた ときの 自動複製 / 測点 未選択 時 の 図 / レポート) が
-- 無修正 で 動き続ける ように する ため。 ライブラリ が 空 で 旧 の 単一断面 に
-- 中身 が ある 場合 は、 画面 側 で 候補 に 「(現在の標準断面)」 と して 出す。
-- その ため データ 移行 は 不要。

ALTER TABLE open_channels
  ADD COLUMN IF NOT EXISTS standard_sections JSONB NOT NULL DEFAULT '[]'::jsonb;
