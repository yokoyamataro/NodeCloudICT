# admin-delete-child-user

管理者ユーザーが自分の子ユーザーを削除する Edge Function。

## 必要な環境変数

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は runtime で自動付与される。

## デプロイ

```sh
supabase functions deploy admin-delete-child-user
```

## 制限

- 自分自身は削除不可
- 削除対象が `profiles.parent_user_id` で呼び出し元を指していない場合は拒否

## 入力 / 出力

```jsonc
// 入力
{ "user_id": "uuid" }

// 成功
{ "ok": true }
```
