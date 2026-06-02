# send-feedback

ヘッダーのメールボタン（FeedbackButton）から、運営者宛に意見・要望を送るための Edge Function。
画像（最大 25MB 相当、base64）を添付として送れる。差出人の身元は JWT で確定するので、なりすましは不可。

## 環境変数

| 変数 | 用途 | 既定値 |
| --- | --- | --- |
| `RESEND_API_KEY` | Resend の API キー | 必須 |
| `NOTIFY_TO` | 通知先メール | `yokoyama1980@gmail.com` |
| `NOTIFY_FROM` | 送信元 | `NodeCloud <onboarding@resend.dev>` |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は runtime で自動付与される。

## デプロイ

```sh
supabase functions deploy send-feedback
supabase secrets set RESEND_API_KEY=...  # 既設の notify-signup と共用で OK
```

`notify-signup` で既に `RESEND_API_KEY` / `NOTIFY_TO` を設定済みなら、そのまま `deploy` だけで動く。
