-- 工区 ファイルストレージ の 上限 を 20MB → 100MB に 引き上げる。
--
-- 元 の トリガ (20260907_add_farm_files.sql: check_farm_files_quota) は
-- 上限 20MB で 二重チェック して いる。 アプリ 側 (FARM_FILE_QUOTA_BYTES)
-- を 100MB に 上げた ので、 DB 側 の 定数 と エラー メッセージ を 揃える。
--
-- Supabase SQL Editor で 実行 して ください。

CREATE OR REPLACE FUNCTION public.check_farm_files_quota()
RETURNS TRIGGER AS $$
DECLARE
  total BIGINT;
  limit_bytes CONSTANT BIGINT := 100 * 1024 * 1024;
BEGIN
  SELECT COALESCE(SUM(size_bytes), 0) INTO total
  FROM public.farm_files
  WHERE farm_id = NEW.farm_id AND expires_at > now();

  IF total + NEW.size_bytes > limit_bytes THEN
    RAISE EXCEPTION
      '工区の容量上限 (100MB) を超えます。使用中 % バイト / 追加 % バイト',
      total, NEW.size_bytes
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';
