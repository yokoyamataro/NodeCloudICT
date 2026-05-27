# notify-signup（申し込みメール通知）

`signup_requests` への INSERT を Database Webhook で受け取り、Resend でメール通知する。

## セットアップ手順

### 1. Resend アカウント＆APIキー
1. https://resend.com で無料アカウント作成（サインアップは通知先と同じ `yokoyama1980@gmail.com` 推奨）
2. API Keys → Create → キーをコピー（`re_xxx`）
3. ドメイン未設定でも、送信元 `onboarding@resend.dev` から **自分のアカウントのメール宛**には送れる（テスト可）。
   独自ドメインから送る場合は Resend で Domain 認証（SPF/DKIM）を行い、`NOTIFY_FROM` を変更。

### 2. シークレット設定（Supabase CLI）
```bash
supabase secrets set RESEND_API_KEY=re_xxxxx
supabase secrets set NOTIFY_TO=yokoyama1980@gmail.com
# 任意（推奨）: Webhook 照合用のランダム文字列
supabase secrets set WEBHOOK_SECRET=$(openssl rand -hex 16)
```

### 3. デプロイ
```bash
supabase functions deploy notify-signup --no-verify-jwt
```
URL: `https://<PROJECT_REF>.supabase.co/functions/v1/notify-signup`
（このプロジェクト: `https://jsqrpiyuzldsyqdvummu.supabase.co/functions/v1/notify-signup`）

### 4. Database Webhook 作成（ダッシュボード）
Supabase ダッシュボード → **Database → Webhooks → Create a new hook**
- Table: `signup_requests`
- Events: **Insert**
- Type: **HTTP Request**, Method **POST**
- URL: 上記の関数URL
- HTTP Headers:
  - `Content-Type: application/json`
  - （WEBHOOK_SECRET を設定した場合）`x-webhook-secret: <設定した値>`

### 5. テスト
`/apply` から1件送信 → メールが届くか確認。
届かない場合は Supabase の Edge Functions ログ（Logs）と Resend のダッシュボードを確認。

## トラブルシューティング
| 症状 | 対処 |
|------|------|
| 500 Server not configured | `RESEND_API_KEY` 未設定。secrets を確認 |
| 403 Forbidden | Webhook の `x-webhook-secret` ヘッダ不一致 |
| 502 Resend error | 送信元ドメイン未認証で他人宛に送ろうとした等。`onboarding@resend.dev` ＋ 自分宛で試す |
| そもそも呼ばれない | Webhook 未作成 / `--no-verify-jwt` なしでデプロイした |
