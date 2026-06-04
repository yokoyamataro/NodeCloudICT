# admin-create-child-user

管理者ユーザー (`profiles.parent_user_id IS NULL` のプロフィール) が、自分の
子ユーザーを作成するための Edge Function。

## 必要な環境変数

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は runtime で自動付与される。
追加の secrets は不要。

## デプロイ

```sh
supabase functions deploy admin-create-child-user
```

## 制限

- 呼び出し元が「子ユーザー」（profiles.parent_user_id IS NOT NULL）の場合は拒否。
  孫ユーザーの作成は不可。
- 呼び出し元の `profiles.child_user_limit` が設定されていれば、既存子ユーザー
  数がそれ以上のとき拒否。
- 作成成功時、親の全工事（project_members.role='owner' / projects.user_id =
  親）に viewer として自動参加させる。

## 入力 / 出力

```jsonc
// 入力
{
  "email": "child@example.com",
  "password": "min6chars",
  "full_name": "子 太郎",
  "organization_id": "uuid-or-null"
}

// 成功
{ "ok": true, "user_id": "uuid" }

// 工事参加で警告
{ "ok": true, "user_id": "uuid", "warning": "..." }

// 失敗
{ "error": "..." }  // 4xx/5xx
```
