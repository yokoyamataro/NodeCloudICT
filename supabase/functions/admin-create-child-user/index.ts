// 管理者ユーザー (admin) が自分の子ユーザー (child) を新規作成する Edge Function。
//
// 動作:
//   1. 呼び出し元の JWT を検証して auth.uid() を取得
//   2. 呼び出し元の profiles を引き、
//      - parent_user_id IS NULL（子ユーザーは孫ユーザーを作れない）
//      - child_user_limit が未設定 or 子の数 < 上限
//      を確認
//   3. service_role で auth.admin.createUser を実行（email_confirm=true、
//      raw_user_meta_data に full_name）
//   4. profiles は handle_new_user_profile トリガで自動生成されるので、
//      作成直後に UPDATE して parent_user_id と plan を設定する
//   5. 親の全工事に viewer で自動参加させる（project_members に INSERT）
//
// 入力（JSON）: { email, password, full_name?, organization_id? }
// 戻り: { ok: true, user_id }
//
// デプロイ: supabase functions deploy admin-create-child-user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface Body {
  email?: string
  password?: string
  full_name?: string
  organization_id?: string
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

  // 呼び出し元の uid を取り出す
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData?.user) return json(401, { error: 'Invalid token' })
  const callerId = callerData.user.id

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    return json(400, { error: 'Bad Request' })
  }

  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const fullName = body.full_name ? String(body.full_name).trim() : null
  const organizationId = body.organization_id ?? null

  if (!email) return json(400, { error: 'email が必要です' })
  if (!password || password.length < 6) {
    return json(400, { error: 'パスワードは 6 文字以上で指定してください' })
  }

  // 呼び出し元のプロフィールを取得して権限・上限を確認
  const { data: callerProfile, error: profileErr } = await admin
    .from('profiles')
    .select('parent_user_id, plan, child_user_limit')
    .eq('user_id', callerId)
    .maybeSingle()
  if (profileErr) return json(500, { error: profileErr.message })
  if (callerProfile?.parent_user_id) {
    return json(403, { error: '子ユーザーはさらに子ユーザーを作成できません' })
  }

  // 現在の子ユーザー数 / 上限チェック
  const limit = callerProfile?.child_user_limit ?? null
  if (limit !== null) {
    const { count, error: cntErr } = await admin
      .from('profiles')
      .select('user_id', { count: 'exact', head: true })
      .eq('parent_user_id', callerId)
    if (cntErr) return json(500, { error: cntErr.message })
    if ((count ?? 0) >= limit) {
      return json(403, {
        error: `子ユーザーの上限 (${limit} 人) に達しています`,
      })
    }
  }

  // auth.users 作成（email_confirm=true で確認メールなしで即ログイン可能に）
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  })
  if (createErr || !created.user) {
    return json(400, { error: createErr?.message ?? 'auth.users 作成に失敗しました' })
  }
  const newUserId = created.user.id

  // profiles 行は handle_new_user_profile トリガで作成済みのはずなので、
  // ここで parent_user_id を上書きする（plan は親と同じものを継承）
  const inheritedPlan = callerProfile?.plan ?? null
  const { error: updErr } = await admin
    .from('profiles')
    .update({
      parent_user_id: callerId,
      plan: inheritedPlan,
      full_name: fullName,
      organization_id: organizationId,
    })
    .eq('user_id', newUserId)
  if (updErr) {
    console.error('profiles UPDATE failed:', updErr)
    // ロールバック: 作成した auth ユーザーを削除
    await admin.auth.admin.deleteUser(newUserId)
    return json(500, { error: `profile 更新に失敗: ${updErr.message}` })
  }

  // 親の全工事に viewer で自動参加
  // - project_members.role='owner' で参加している工事
  // - 後方互換: projects.user_id = 親 の工事
  const projectIds = new Set<string>()
  {
    const { data: owned } = await admin
      .from('project_members')
      .select('project_id')
      .eq('user_id', callerId)
      .eq('role', 'owner')
    for (const row of owned ?? []) projectIds.add(row.project_id)
  }
  {
    const { data: legacy } = await admin
      .from('projects')
      .select('id')
      .eq('user_id', callerId)
    for (const row of legacy ?? []) projectIds.add(row.id)
  }
  if (projectIds.size > 0) {
    const rows = Array.from(projectIds).map((pid) => ({
      project_id: pid,
      user_id: newUserId,
      role: 'viewer' as const,
    }))
    // 既存の project_members 行と重複してもエラーにしない
    const { error: insErr } = await admin
      .from('project_members')
      .upsert(rows, { onConflict: 'project_id,user_id' })
    if (insErr) {
      console.error('project_members upsert failed:', insErr)
      // viewer 参加に失敗してもユーザー自体は作成済み。明示的に伝える
      return json(207, {
        ok: true,
        user_id: newUserId,
        warning: `参加させる工事への自動追加に一部失敗: ${insErr.message}`,
      })
    }
  }

  return json(200, { ok: true, user_id: newUserId })
})
