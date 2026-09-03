-- 線形物 (open_channels) の 既存横断図 DXF を 複数枚 対応。
-- 従来: dxf_cross_section_path / _name の scalar 1 組 (1 枚のみ)
-- 今回: dxf_cross_sections JSONB 配列 (複数枚。各要素は { id, name, path, addedAt? })
--
-- 旧 scalar column は 一旦 残す (後方互換 / 段階移行)。
-- アプリ側で 読み込み時に「dxf_cross_sections が 空 かつ 旧 scalar が セット」
-- なら 自動で 配列化 して 扱う (toRow 参照)。
--
-- Supabase SQL Editor で 実行してください。

ALTER TABLE public.open_channels
  ADD COLUMN IF NOT EXISTS dxf_cross_sections JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.open_channels.dxf_cross_sections IS
  '既存横断図 DXF ファイル 一覧 (複数枚 対応)。 要素は { id, name, path, addedAt? }。
   path は storage.objects.name (bucket=open-channel-dxf)。
   station.dxfCrossSectionId で 「どの DXF を 対象と するか」を 紐付ける。';

-- Storage バケット 側は 変更なし ('open-channel-dxf' は 既に 作成済み、
-- 20260902_add_open_channel_dxf.sql 参照)。
