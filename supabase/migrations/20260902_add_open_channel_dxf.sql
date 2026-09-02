-- 線形物 (open_channels) に 既存横断図 DXF ファイルを 添付できるように する。
-- 1 チャンネル = 1 DXF (工区全体の 並べ図)。ファイル自体は Supabase Storage、
-- open_channels 側は パスと ファイル名だけ 保持する 1:1 構成 (meta テーブル なし)。
--
-- 保存先: bucket 'open-channel-dxf' 配下、パスは '<farmId>/<channelId>-<uuid>.dxf'
-- RLS: 工区メンバー (is_farm_viewer / is_farm_editor) にだけ 可
--
-- Supabase SQL Editor で 実行してください。

-- ============================================================
-- 1. open_channels カラム追加
-- ============================================================

ALTER TABLE public.open_channels
  ADD COLUMN IF NOT EXISTS dxf_cross_section_path TEXT,
  ADD COLUMN IF NOT EXISTS dxf_cross_section_name TEXT;

COMMENT ON COLUMN public.open_channels.dxf_cross_section_path IS
  '既存横断図 DXF の storage.objects.name (bucket=open-channel-dxf)。NULL なら 未取込。';
COMMENT ON COLUMN public.open_channels.dxf_cross_section_name IS
  'アップロード 時の 元 ファイル名 (表示用)。';

-- ============================================================
-- 2. Storage バケット (プライベート)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('open-channel-dxf', 'open-channel-dxf', false)
ON CONFLICT (id) DO NOTHING;

-- パス先頭セグメント = farm_id を 想定。 '<farmId>/<channelId>-<uuid>.dxf'

DROP POLICY IF EXISTS "open_channel_dxf_select" ON storage.objects;
DROP POLICY IF EXISTS "open_channel_dxf_insert" ON storage.objects;
DROP POLICY IF EXISTS "open_channel_dxf_update" ON storage.objects;
DROP POLICY IF EXISTS "open_channel_dxf_delete" ON storage.objects;

CREATE POLICY "open_channel_dxf_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'open-channel-dxf'
    AND public.is_farm_viewer(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "open_channel_dxf_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'open-channel-dxf'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "open_channel_dxf_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'open-channel-dxf'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "open_channel_dxf_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'open-channel-dxf'
    AND public.is_farm_editor(((storage.foldername(name))[1])::uuid)
  );
