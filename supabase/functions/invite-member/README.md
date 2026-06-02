# invite-member Edge Function

オーナーがアプリ内でメンバーを招待するための Edge Function。

## 役割

- 呼び出し元の JWT を検証し `is_project_owner(project_id)` でオーナー判定。
- 招待先メールがすでに `auth.users` に存在する場合は `project_members` に直接 INSERT。
- 未登録メールの場合は `pending_invitations` にレコードを保存したうえで
  `supabase.auth.admin.inviteUserByEmail()` を呼んで招待リンクをメール送信する。

招待された人がリンクからパスワードを設定すると、
`auth.users` への INSERT を拾う `handle_pending_invitations` トリガが
自動で `project_members` にレコードを作る（migration: `20260602b_add_pending_invitations.sql`）。

## デプロイ手順

```bash
# 1. Edge Function をデプロイ
supabase functions deploy invite-member

# 2. 招待リンク受領ページの絶対 URL を Secret に登録
#    例: https://nodecloud-ict.example.com
supabase secrets set PUBLIC_APP_URL=https://your-app.example.com

# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は Edge Function 環境で自動付与されるため
# 手動で設定する必要はない。
```

## Supabase Dashboard 側の設定

1. **Authentication > URL Configuration > Redirect URLs** に
   `https://<アプリのドメイン>/accept-invite` を追加する。
2. **Authentication > Email Templates > Invite user** のテンプレートを
   日本語化したい場合はここで編集。本文中の `{{ .ConfirmationURL }}` が招待リンク。
3. **Authentication > SMTP Settings** は本番運用では独自 SMTP（Resend など）に切り替える。
   Supabase デフォルト SMTP は時間あたりの送信数が厳しく制限される。

## 関連マイグレーション

- `20260602_project_members_owner_can_delete.sql` ... `is_project_owner` 関数の定義
- `20260602b_add_pending_invitations.sql`         ... `pending_invitations` テーブル + トリガ
