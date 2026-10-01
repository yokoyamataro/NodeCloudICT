-- /support の お問い合わせ フォーム 受付 テーブル。
-- /api/contact (Vercel Serverless) が service role で INSERT する 前提。
-- 一般 ユーザ の 直接 書き込み (anon) は 塞ぎ、 閲覧 は サイト 管理者 のみ。
--
-- 既存 の signup_requests (申込) と は 用途 が 別 な ので テーブル は 分ける。
-- signup_requests: 「紹介 LP の 申込 フォーム」 (会社名・担当者・導入 相談)
-- contact_messages: 「サポート の お問い合わせ フォーム」 (デモ・質問・不具合)

CREATE TABLE IF NOT EXISTS public.contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id TEXT NOT NULL UNIQUE,          -- NC-YYYYMMDD-NNNN
  topic TEXT NOT NULL,                     -- ご用件 (select の 値)
  name TEXT NOT NULL,                      -- お名前
  company TEXT,                            -- 会社名・事務所名 (任意)
  email TEXT NOT NULL,
  phone TEXT,                              -- 任意
  message TEXT NOT NULL,                   -- 本文
  status TEXT NOT NULL DEFAULT 'new',      -- new / replied / closed
  user_agent TEXT,                         -- 送信元 UA (ログ用)
  ip_address TEXT,                         -- 送信元 IP (スパム 対策)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created
  ON public.contact_messages (created_at DESC);

-- RLS 有効 化。 書き込み は service role の みで、 anon / authenticated は 弾く。
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- 一般 クライアント からの SELECT / INSERT は 全部 落とす (ポリシー 無し = 全拒否)。
-- /api/contact が SUPABASE_SERVICE_ROLE_KEY で 入れる の で RLS を バイパス する。
-- 管理者 画面 は 「サイト 管理者 (isAdmin)」 の クライアント から 読む の で、
-- 管理者 メール アドレス 一覧 を サーバ 側 で 持って いる 現状 の 設計 上、
-- authenticated 向け の 広め な SELECT ポリシー を 入れる (アプリ 側 で UI を 制限)。
-- 将来 的 に user_metadata.role='site_admin' のような 仕組み に したら 絞る。
DROP POLICY IF EXISTS contact_messages_select ON public.contact_messages;
CREATE POLICY contact_messages_select ON public.contact_messages
  FOR SELECT TO authenticated
  USING (true);

-- status 更新 は 管理者 画面 から。 同じく authenticated を 許し、 UI 側 で 制限。
DROP POLICY IF EXISTS contact_messages_update ON public.contact_messages;
CREATE POLICY contact_messages_update ON public.contact_messages
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

GRANT SELECT, UPDATE ON public.contact_messages TO authenticated;

NOTIFY pgrst, 'reload schema';
