// メンバー招待 Edge Function。
//
// 2 種類の招待に対応:
//   A. プロジェクト招待  … body に project_id + role
//                        オーナー判定 → project_members へ upsert / 未登録なら
//                        pending_invitations + invite mail
//   B. 組織メンバー招待  … body に organization_id + org_role
//                        サイトオーナー or 組織 admin 判定 → organization_members
//                        へ upsert / 未登録なら pending_invitations + invite mail
//                        既登録者が別組織所属なら 409 (併属禁止)
//
// 必要な環境変数:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (runtime で自動注入)
//   PUBLIC_APP_URL — 招待リンク遷移先 (例: https://app.example.com)
//
// デプロイ: supabase functions deploy invite-member

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ProjectRole = 'owner' | 'editor' | 'viewer'
type OrgRole = 'admin' | 'member'

interface InviteBody {
  // プロジェクト招待
  project_id?: string
  role?: ProjectRole
  // 組織招待
  organization_id?: string
  org_role?: OrgRole
  // 共通
  email?: string
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

  // 呼び出し元 JWT
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) return json(401, { error: 'Not authenticated' }, origin)

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData.user) return json(401, { error: 'Not authenticated' }, origin)
  const callerId = callerData.user.id
  const callerEmail = (callerData.user.email ?? '').toLowerCase()

  let body: InviteBody
  try {
    body = (await req.json()) as InviteBody
  } catch {
    return json(400, { error: 'Bad Request' }, origin)
  }

  const emailRaw = body.email?.trim().toLowerCase()
  if (!emailRaw) return json(400, { error: 'Missing email' }, origin)

  // 排他: project or organization どちらか一方 (両方指定はエラー)
  const hasProject = !!body.project_id
  const hasOrg = !!body.organization_id
  if (hasProject === hasOrg) {
    return json(400, {
      error: 'Specify exactly one of project_id or organization_id',
    }, origin)
  }

  // 既存ユーザーをメールで検索するヘルパ
  async function findUserIdByEmail(email: string): Promise<string | null> {
    // listUsers はページング必要。10 ページ (2000 件) までフォールバック
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({
        page,
        perPage: 200,
      })
      if (error) throw error
      const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email)
      if (hit) return hit.id
      if (data.users.length < 200) break
    }
    return null
  }

  // 招待メール送信 (Supabase Invite テンプレを利用)
  async function sendInvite(email: string) {
    const redirectTo = redirectBase
      ? `${redirectBase.replace(/\/$/, '')}/accept-invite`
      : undefined
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
    })
    if (error) throw new Error(error.message)
  }

  // サイトオーナー判定 (フロントと同じくメールでハードコード)
  const SITE_OWNER_EMAILS = new Set(['yokoyama1980@gmail.com'])
  const isSiteOwner = SITE_OWNER_EMAILS.has(callerEmail)

  // ============================================================
  // A. プロジェクト招待
  // ============================================================
  if (hasProject) {
    const projectId = body.project_id!
    const role = body.role
    if (!role || !['owner', 'editor', 'viewer'].includes(role)) {
      return json(400, { error: 'Invalid role' }, origin)
    }

    // オーナー判定 (site owner 経由 or projects.user_id or project_members owner)
    let ownerOk = isSiteOwner
    if (!ownerOk) {
      const { data: projRow } = await admin
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .maybeSingle()
      if (projRow && (projRow as { user_id: string }).user_id === callerId) {
        ownerOk = true
      }
    }
    if (!ownerOk) {
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
    if (!ownerOk) return json(403, { error: 'Not project owner' }, origin)

    // 既存ユーザー検索
    let existingUserId: string | null = null
    try {
      existingUserId = await findUserIdByEmail(emailRaw)
    } catch (err) {
      return json(500, { error: 'User lookup failed: ' + (err as Error).message }, origin)
    }

    if (existingUserId) {
      const { data: existing } = await admin
        .from('project_members')
        .select('id, role')
        .eq('project_id', projectId)
        .eq('user_id', existingUserId)
        .maybeSingle()
      if (existing) {
        const cur = existing as { id: string; role: string }
        if (cur.role === 'owner') {
          return json(409, { error: 'このユーザーは既にオーナーです' }, origin)
        }
        if (cur.role !== role) {
          const { error: updErr } = await admin
            .from('project_members')
            .update({ role })
            .eq('id', cur.id)
          if (updErr) {
            return json(500, { error: 'Member update failed: ' + updErr.message }, origin)
          }
        }
        return json(200, { ok: true, status: 'added_existing_user' }, origin)
      }
      const { error } = await admin
        .from('project_members')
        .insert({ project_id: projectId, user_id: existingUserId, role })
      if (error) {
        return json(500, { error: 'Member insert failed: ' + error.message }, origin)
      }
      return json(200, { ok: true, status: 'added_existing_user' }, origin)
    }

    // 未登録 → pending_invitations + 招待メール
    const { error: pendErr } = await admin
      .from('pending_invitations')
      .upsert(
        {
          project_id: projectId,
          email: emailRaw,
          role,
          invited_by: callerId,
        },
        { onConflict: 'project_id,email' },
      )
    if (pendErr) {
      return json(500, { error: 'Pending insert failed: ' + pendErr.message }, origin)
    }
    try {
      await sendInvite(emailRaw)
    } catch (err) {
      return json(500, { error: 'Invite send failed: ' + (err as Error).message }, origin)
    }
    return json(200, { ok: true, status: 'invited' }, origin)
  }

  // ============================================================
  // B. 組織招待
  // ============================================================
  const orgId = body.organization_id!
  const orgRole = body.org_role
  if (!orgRole || !['admin', 'member'].includes(orgRole)) {
    return json(400, { error: 'Invalid org_role' }, origin)
  }

  // 権限: サイトオーナー or 対象組織の admin
  let orgOk = isSiteOwner
  if (!orgOk) {
    const { data: omRow } = await admin
      .from('organization_members')
      .select('role')
      .eq('organization_id', orgId)
      .eq('user_id', callerId)
      .maybeSingle()
    if (omRow && (omRow as { role: string }).role === 'admin') {
      orgOk = true
    }
  }
  if (!orgOk) return json(403, { error: 'Not organization admin' }, origin)

  // 既存ユーザー検索
  let existingUserId: string | null = null
  try {
    existingUserId = await findUserIdByEmail(emailRaw)
  } catch (err) {
    return json(500, { error: 'User lookup failed: ' + (err as Error).message }, origin)
  }

  if (existingUserId) {
    // 既存: 別組織所属チェック → 併属禁止で 409
    const { data: profRow } = await admin
      .from('profiles')
      .select('organization_id')
      .eq('user_id', existingUserId)
      .maybeSingle()
    const currentOrg = (profRow as { organization_id: string | null } | null)
      ?.organization_id
    if (currentOrg && currentOrg !== orgId) {
      return json(
        409,
        {
          ok: false,
          error: 'このユーザーは既に別の組織に所属しています',
        },
        origin,
      )
    }

    // organization_members に upsert
    const { error: omErr } = await admin
      .from('organization_members')
      .upsert(
        {
          organization_id: orgId,
          user_id: existingUserId,
          role: orgRole,
          invited_by: callerId,
        },
        { onConflict: 'organization_id,user_id' },
      )
    if (omErr) {
      return json(500, { error: 'Member insert failed: ' + omErr.message }, origin)
    }
    // profiles.organization_id を空ならセット
    const { error: upErr } = await admin
      .from('profiles')
      .upsert(
        {
          user_id: existingUserId,
          organization_id: currentOrg ?? orgId,
        },
        { onConflict: 'user_id' },
      )
    if (upErr) {
      // 失敗しても組織メンバー登録自体は成功しているので警告のみ
      console.warn('[invite-member] profile upsert failed:', upErr.message)
    }
    return json(200, { ok: true, status: 'added_existing_user' }, origin)
  }

  // 未登録 → pending_invitations (organization_id + org_role) + 招待メール
  const { error: pendErr } = await admin
    .from('pending_invitations')
    .insert({
      organization_id: orgId,
      email: emailRaw,
      org_role: orgRole,
      invited_by: callerId,
    })
  if (pendErr) {
    // 同メールで既に pending がある場合は 409 相当のエラー。UI 側でハンドリング。
    if ((pendErr as { code?: string }).code === '23505') {
      return json(409, { error: '既に招待中のメールアドレスです' }, origin)
    }
    return json(500, { error: 'Pending insert failed: ' + pendErr.message }, origin)
  }
  try {
    await sendInvite(emailRaw)
  } catch (err) {
    return json(500, { error: 'Invite send failed: ' + (err as Error).message }, origin)
  }
  return json(200, { ok: true, status: 'invited' }, origin)
})
