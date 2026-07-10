// サイトオーナー限定: ユーザーをアカウントごと完全削除する Edge Function。
//
// 動作:
//   1. 呼び出し元の JWT を検証し、is_site_owner() で権限を確認。
//   2. body.user_id で対象を受け取る。自分自身は削除できない。
//   3. 対象ユーザーが projects.user_id で 1 件でも工事を所有していれば拒否
//      (ゴミ箱内の soft-deleted も含める)。
//   4. 上記が通ったら auth.admin.deleteUser で完全削除。
//      profiles などは FK ON DELETE CASCADE で自動追随する想定。
//
// 必要な環境変数:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase 側で自動注入される)
//
// デプロイ: supabase functions deploy admin-delete-user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface DeleteBody {
  user_id?: string
}

function makeCors(origin?: string) {
  const allowOrigin = origin && origin !== '' ? origin : '*'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  }
}

const json = (status: number, body: unknown, origin?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...makeCors(origin) },
  })

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? undefined
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: makeCors(origin) })
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, origin)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return json(500, { ok: false, error: 'Server not configured' }, origin)
  }

  // 呼び出し元 JWT
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData.user) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }
  const callerId = callerData.user.id

  // サイトオーナー判定は JWT を通した anon クライアントで is_site_owner() を呼ぶ
  const asCaller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  })
  const { data: siteOwner, error: soErr } = await asCaller.rpc('is_site_owner')
  if (soErr) {
    return json(500, { ok: false, error: 'Site owner check failed: ' + soErr.message }, origin)
  }
  if (siteOwner !== true) {
    return json(403, { ok: false, error: 'Not authorized (site owner only)' }, origin)
  }

  // body
  let body: DeleteBody
  try {
    body = (await req.json()) as DeleteBody
  } catch {
    return json(400, { ok: false, error: 'Bad Request' }, origin)
  }
  const targetId = body.user_id
  if (!targetId) {
    return json(400, { ok: false, error: 'user_id required' }, origin)
  }
  if (targetId === callerId) {
    return json(400, { ok: false, error: '自分自身は削除できません' }, origin)
  }

  // 所有工事チェック (soft-deleted 含む: ゴミ箱内でも「所有中」扱い)
  const { count, error: cErr } = await admin
    .from('projects')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', targetId)
  if (cErr) {
    return json(500, { ok: false, error: 'Project count failed: ' + cErr.message }, origin)
  }
  if ((count ?? 0) > 0) {
    return json(
      400,
      {
        ok: false,
        error: `このユーザーは ${count} 件の工事を所有しています。先に工事を削除 (完全削除まで) してください。`,
        project_count: count,
      },
      origin,
    )
  }

  // 削除
  const { error: delErr } = await admin.auth.admin.deleteUser(targetId)
  if (delErr) {
    return json(500, { ok: false, error: 'Delete failed: ' + delErr.message }, origin)
  }

  return json(200, { ok: true }, origin)
})
