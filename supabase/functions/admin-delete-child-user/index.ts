// 管理者ユーザーが自分の子ユーザーを削除する Edge Function。
//
// 動作:
//   1. 呼び出し元の JWT を検証
//   2. 削除対象 (user_id) が呼び出し元の子であることを profiles で確認
//   3. service_role で auth.admin.deleteUser を実行
//      → profiles の ON DELETE CASCADE / project_members の ON DELETE CASCADE
//        により関連レコードも消える
//
// 入力（JSON）: { user_id }
// 戻り: { ok: true }
//
// デプロイ: supabase functions deploy admin-delete-child-user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface Body {
  user_id?: string
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: 'Server not configured' })
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) return json(401, { error: 'Not authenticated' })

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData?.user) return json(401, { error: 'Invalid token' })
  const callerId = callerData.user.id

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'Bad Request' })
  }

  const targetUserId = String(body.user_id ?? '').trim()
  if (!targetUserId) return json(400, { error: 'user_id が必要です' })
  if (targetUserId === callerId) {
    return json(400, { error: '自分自身は削除できません' })
  }

  // 対象が呼び出し元の子であることを確認
  const { data: target, error: targetErr } = await admin
    .from('profiles')
    .select('parent_user_id')
    .eq('user_id', targetUserId)
    .maybeSingle()
  if (targetErr) return json(500, { error: targetErr.message })
  if (!target) return json(404, { error: '指定の子ユーザーは存在しません' })
  if (target.parent_user_id !== callerId) {
    return json(403, { error: 'この子ユーザーを削除する権限がありません' })
  }

  // auth.users から削除（profiles 等は CASCADE で消える）
  const { error: delErr } = await admin.auth.admin.deleteUser(targetUserId)
  if (delErr) {
    return json(500, { error: `削除に失敗: ${delErr.message}` })
  }

  return json(200, { ok: true })
})
