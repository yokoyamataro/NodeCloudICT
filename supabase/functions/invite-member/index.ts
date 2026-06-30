// オーナーが「メール + 権限」でメンバーを招待する Edge Function。
//
// 動作:
//   1. 呼び出し元の JWT を検証し、auth.uid() を取得。
//   2. is_project_owner(project_id) でオーナーであることを確認。
//   3. auth.admin.listUsers でメールから既存ユーザーを検索。
//      - 既存ユーザーが見つかれば project_members に直接 INSERT。
//      - 見つからなければ pending_invitations に INSERT したうえで
//        auth.admin.inviteUserByEmail を呼び招待メールを発送する。
//
// 必要な環境変数（supabase secrets set ...）:
//   SUPABASE_URL                   ... 既定で利用可能（runtime 環境変数）
//   SUPABASE_SERVICE_ROLE_KEY      ... 既定で利用可能（runtime 環境変数）
//   PUBLIC_APP_URL                 ... 招待リンクからのリダイレクト先
//                                      （例: https://app.example.com/accept-invite）
//
// デプロイ: supabase functions deploy invite-member

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type Role = 'owner' | 'editor' | 'viewer'

interface InviteBody {
  project_id?: string
  email?: string
  role?: Role
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
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: makeCors(origin) })
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' }, origin)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const redirectBase = Deno.env.get('PUBLIC_APP_URL') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: 'Server not configured' }, origin)
  }

  // 呼び出し元の JWT を取り出して uid を取得
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) return json(401, { error: 'Not authenticated' })

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData.user) return json(401, { error: 'Not authenticated' }, origin)
  const callerId = callerData.user.id

  // body
  let body: InviteBody
  try {
    body = (await req.json()) as InviteBody
  } catch {
    return json(400, { error: 'Bad Request' }, origin)
  }
  const projectId = body.project_id
  const emailRaw = body.email?.trim().toLowerCase()
  const role = body.role
  if (!projectId || !emailRaw || !role) return json(400, { error: 'Missing fields' }, origin)
  if (!['owner', 'editor', 'viewer'].includes(role)) {
    return json(400, { error: 'Invalid role' }, origin)
  }

  // オーナー判定（is_project_owner を SECURITY DEFINER 関数として用意済み）
  const { data: isOwner, error: ownerErr } = await admin.rpc('is_project_owner', {
    p_project_id: projectId,
  })
  if (ownerErr) return json(500, { error: 'Owner check failed: ' + ownerErr.message }, origin)
  // 注: is_project_owner は内部で auth.uid() を見るが、service_role で呼ぶと
  // auth.uid() が NULL になるため、ここではあえて service role 経由のチェックは
  // 行わず、別 SQL で「projects.user_id = callerId OR project_members.role='owner'」
  // を直接照会する。
  let ownerOk = isOwner === true
  if (!ownerOk) {
    const { data: projRow } = await admin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle()
    if (projRow && (projRow as { user_id: string }).user_id === callerId) {
      ownerOk = true
    } else {
      const { data: pmRow } = await admin
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', callerId)
        .maybeSingle()
      if (pmRow && (pmRow as { role: string }).role === 'owner') {
        ownerOk = true
      }
    }
  }
  if (!ownerOk) return json(403, { error: 'Not project owner' })

  // 既存ユーザーをメールで検索（auth.admin.listUsers にメールフィルタが無いので
  // listUsers ではなく直接 admin.from('users') ... と auth スキーマも参照できないため、
  // ここは Supabase Admin API の getUserByEmail 相当のヘルパを使う）。
  // @supabase/supabase-js v2 では admin.getUserById のみ。メール検索は
  // listUsers + 自前フィルタが正攻法だが、件数が増えると重いので
  // auth スキーマの REST 経由で問い合わせる。
  let existingUserId: string | null = null
  try {
    const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (error) throw error
    const hit = list.users.find((u) => (u.email ?? '').toLowerCase() === emailRaw)
    if (hit) existingUserId = hit.id
  } catch (err) {
    return json(500, { error: 'User lookup failed: ' + (err as Error).message }, origin)
  }

  // ケース A: 既存ユーザー → project_members を upsert
  // 既にメンバー登録されている相手にもう一度 invite された場合は、エラーを返さず
  // 指定ロールに更新する（UI 上「閲覧者として登録済の人に編集権限を付与」したい
  // ケースを救う）。ただし既存が owner の場合は降格させないため触らない。
  if (existingUserId) {
    const { data: existing, error: selErr } = await admin
      .from('project_members')
      .select('id, role')
      .eq('project_id', projectId)
      .eq('user_id', existingUserId)
      .maybeSingle()
    if (selErr) {
      return json(500, { error: 'Member lookup failed: ' + selErr.message }, origin)
    }

    if (existing) {
      const cur = (existing as { id: string; role: string })
      if (cur.role === 'owner') {
        return json(409, { error: 'このユーザーは既にオーナーです' }, origin)
      }
      if (cur.role === role) {
        return json(200, { ok: true, mode: 'added_existing' }, origin)
      }
      const { error: updErr } = await admin
        .from('project_members')
        .update({ role })
        .eq('id', cur.id)
      if (updErr) {
        return json(500, { error: 'Member update failed: ' + updErr.message }, origin)
      }
      return json(200, { ok: true, mode: 'added_existing' }, origin)
    }

    const { error } = await admin
      .from('project_members')
      .insert({ project_id: projectId, user_id: existingUserId, role })
    if (error) {
      if (error.code === '23505') {
        return json(409, { error: 'このユーザーは既にメンバーです' }, origin)
      }
      return json(500, { error: 'Member insert failed: ' + error.message }, origin)
    }
    return json(200, { ok: true, mode: 'added_existing' }, origin)
  }

  // ケース B: 未登録ユーザー → pending_invitations + 招待メール
  // 1) pending_invitations に保存
  const { error: pendErr } = await admin
    .from('pending_invitations')
    .upsert(
      { project_id: projectId, email: emailRaw, role, invited_by: callerId },
      { onConflict: 'project_id,email' },
    )
  if (pendErr) {
    return json(500, { error: 'Pending insert failed: ' + pendErr.message }, origin)
  }

  // 2) 招待メール送信（Supabase Auth の Invite テンプレが使われる）
  const redirectTo = redirectBase
    ? `${redirectBase.replace(/\/$/, '')}/accept-invite`
    : undefined
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(emailRaw, {
    redirectTo,
  })
  if (inviteErr) {
    return json(500, { error: 'Invite send failed: ' + inviteErr.message }, origin)
  }

  return json(200, { ok: true, mode: 'invited' }, origin)
})
