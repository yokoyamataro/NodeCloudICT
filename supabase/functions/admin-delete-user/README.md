# admin-delete-user

サイトオーナーがユーザーをアカウントごと完全削除するための Edge Function。

## 権限

- 呼び出し元 JWT が `is_site_owner()` を満たす必要がある (現状は `yokoyama1980@gmail.com`)。
- 自分自身は削除できない (`400`)。

## 動作

1. 呼び出し元 JWT を検証しサイトオーナーであることを確認。
2. body の `user_id` で対象を受け取る。
3. `projects.user_id = target` の件数を確認 (ゴミ箱内も含む)。
   1 件以上あれば `400` を返し、拒否メッセージに件数を含める。
4. `auth.admin.deleteUser` で削除。`profiles` は `ON DELETE CASCADE`、
   `organizations.admin_user_id` は `SET NULL` で自動追随する。

## リクエスト

```json
{
  "user_id": "<uuid>"
}
```

## レスポンス (成功時)

```json
{ "ok": true }
```

## デプロイ

```
supabase functions deploy admin-delete-user
```
