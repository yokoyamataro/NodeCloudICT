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
// メール送信は全て Resend 経由:
//   * Supabase の組み込み SMTP は 1 時間 4 通のレート制限があり実運用に耐えない
//   * 未登録ユーザー → admin.generateLink({type:'invite'}) で action_link を取り、
//                     Resend で自前 HTML テンプレを送信
//   * 既存ユーザー → 通知メール (「追加されました」) を Resend で送信
//
// 必要な環境変数:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (runtime で自動注入)
//   PUBLIC_APP_URL — 招待リンク遷移先 (例: https://app.example.com)
//   RESEND_API_KEY — 全メール送信で必須 (未設定だと招待メール自体が送れない)
//   NOTIFY_FROM    — メールの From (省略時 'NodeCloud <onboarding@resend.dev>')
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
  // 共通 - email または phone のどちらか
  email?: string
  phone?: string
}

/** 日本の電話番号を E.164 に正規化。
 *   '090-1234-5678' / '09012345678' → '+819012345678'
 *   '+819012345678' / '819012345678' → '+819012345678'
 *   国際形式 '+xx...' は先頭 + を保ったまま数字だけ抽出
 *   0 始まりの 10-11 桁は日本国内番号として +81 を付与
 *   マッチしない場合は null (呼び出し側でエラー)
 */
function normalizeJpPhone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const isIntl = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (isIntl) {
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }
  // 日本国内: 先頭 0 を除去し +81 を付ける
  if (digits.length >= 10 && digits.length <= 11 && digits.startsWith('0')) {
    return `+81${digits.substring(1)}`
  }
  // 81 で始まる 12-13 桁 (先頭 + が省略された国際表記)
  if (digits.startsWith('81') && digits.length >= 11 && digits.length <= 13) {
    return `+${digits}`
  }
  return null
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

  const emailRaw = body.email?.trim().toLowerCase() || null
  const phoneRaw = body.phone ? normalizeJpPhone(body.phone) : null
  if (!emailRaw && !phoneRaw) {
    return json(400, { error: 'Missing email or phone' }, origin)
  }
  if (body.phone && !phoneRaw) {
    return json(400, { error: '電話番号の形式が正しくありません' }, origin)
  }

  // 排他: project or organization どちらか一方 (両方指定はエラー)
  const hasProject = !!body.project_id
  const hasOrg = !!body.organization_id
  if (hasProject === hasOrg) {
    return json(400, {
      error: 'Specify exactly one of project_id or organization_id',
    }, origin)
  }

  // プロジェクト招待は現状 email のみ対応 (電話番号招待は組織のみ)
  if (hasProject && !emailRaw) {
    return json(400, { error: 'プロジェクト招待は電話番号非対応 (email 必須)' }, origin)
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

  // 既存ユーザーを電話番号で検索するヘルパ
  async function findUserIdByPhone(phone: string): Promise<string | null> {
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({
        page,
        perPage: 200,
      })
      if (error) throw error
      const hit = data.users.find((u) => (u.phone ?? '') === phone)
      if (hit) return hit.id
      if (data.users.length < 200) break
    }
    return null
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Supabase Auth に「未確認ユーザー行を作って action_link だけ受け取る」ヘルパ。
  // メール自体は Supabase からは送らない (Resend で自前送信する)。
  //   * redirectTo は /accept-invite を指す。
  //   * このヘルパを呼んだ時点で auth.users に unconfirmed 行が作られ、
  //     handle_pending_invitations トリガが pending_invitations を取り込む。
  //     そのため呼び出し順は「pending_invitations INSERT → generateInviteLink」
  //     でなければならない。
  async function generateInviteLink(email: string): Promise<string> {
    const redirectTo = redirectBase
      ? `${redirectBase.replace(/\/$/, '')}/accept-invite`
      : undefined
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: redirectTo ? { redirectTo } : undefined,
    })
    if (error) {
      // Supabase Auth の AuthError は場合によって message が空/欠落するので、
      // 主要フィールドを全部拾って診断できるようにする。
      const e = error as {
        message?: string
        error_description?: string
        code?: string
        status?: number
        name?: string
      }
      const parts: string[] = []
      if (e.message) parts.push(e.message)
      if (e.error_description) parts.push(e.error_description)
      if (e.code) parts.push(`code=${e.code}`)
      if (e.status != null) parts.push(`status=${e.status}`)
      if (e.name) parts.push(`name=${e.name}`)
      const summary = parts.length > 0 ? parts.join(' | ') : JSON.stringify(error)
      console.error('[invite-member] generateLink failed:', JSON.stringify(error))
      throw new Error(`generateLink: ${summary}`)
    }
    const link = (data as { properties?: { action_link?: string } })?.properties?.action_link
    if (!link) throw new Error('generateLink returned no action_link')
    return link
  }

  // Resend で HTML メールを送る低レベルヘルパ。
  async function sendResendMail(params: {
    to: string
    subject: string
    html: string
  }) {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      throw new Error('RESEND_API_KEY not configured; cannot send email')
    }
    const from = Deno.env.get('NOTIFY_FROM') ?? 'NodeCloud <onboarding@resend.dev>'
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Resend ${res.status}: ${text}`)
    }
  }

  // 未登録ユーザーへの「プロジェクト招待」メール送信 (Resend 経由)。
  //   1. generateInviteLink で action_link を取得
  //   2. 丁寧トーンの HTML テンプレで Resend に投げる
  async function sendProjectInviteEmail(
    toEmail: string,
    projectName: string,
    inviterEmail: string,
    role: ProjectRole,
  ) {
    const actionLink = await generateInviteLink(toEmail)
    const roleLabel =
      role === 'owner' ? '管理者' : role === 'editor' ? '編集者' : '閲覧者'
    const projectNameEsc = escapeHtml(projectName)
    const inviterEsc = escapeHtml(inviterEmail)
    const roleLabelEsc = escapeHtml(roleLabel)
    const linkEsc = escapeHtml(actionLink)
    const subject = `【NodeCloud】現場「${projectName}」へご招待いただきました`
    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Meiryo,sans-serif;font-size:14px;color:#111;line-height:1.75;max-width:560px;margin:0 auto;padding:8px;">
  <p style="margin:0 0 12px;">お世話になっております。NodeCloud 事務局です。</p>
  <p style="margin:0 0 12px;">
    このたび <strong>${inviterEsc}</strong> 様より、お客様を NodeCloud の現場
    <strong>「${projectNameEsc}」</strong> の <strong>${roleLabelEsc}</strong>
    として共有メンバーにご招待いただきました。
  </p>
  <p style="margin:16px 0 8px;">下記のリンクからアカウント登録・ログインを行っていただくと、共有された現場をご利用いただけます。</p>
  <p style="margin:0 0 16px;">
    <a href="${linkEsc}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
      招待を受ける
    </a>
  </p>
  <p style="color:#666;font-size:12px;margin:0 0 16px;">
    リンクが開かない場合は、下記 URL をブラウザに貼り付けてご利用ください。<br />
    ${linkEsc}
  </p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:13px;">
    <div style="color:#64748b;margin-bottom:4px;">■ 詳細</div>
    <div>現場名: <strong>${projectNameEsc}</strong></div>
    <div>権限: <strong>${roleLabelEsc}</strong></div>
    <div>招待者: ${inviterEsc}</div>
  </div>
  <p style="color:#666;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px;">
    本メールにお心当たりが無い場合は、恐れ入りますがそのまま破棄いただきますようお願いいたします。
  </p>
  <p style="color:#94a3b8;font-size:12px;margin:4px 0 0;">NodeCloud 事務局</p>
</div>
    `
    await sendResendMail({ to: toEmail, subject, html })
  }

  // 未登録ユーザーへの「組織招待」メール送信 (Resend 経由)。
  async function sendOrgInviteEmail(
    toEmail: string,
    orgName: string,
    inviterEmail: string,
    orgRole: OrgRole,
  ) {
    const actionLink = await generateInviteLink(toEmail)
    const roleLabel = orgRole === 'admin' ? '管理者' : '一般メンバー'
    const orgNameEsc = escapeHtml(orgName)
    const inviterEsc = escapeHtml(inviterEmail)
    const roleLabelEsc = escapeHtml(roleLabel)
    const linkEsc = escapeHtml(actionLink)
    const subject = `【NodeCloud】組織「${orgName}」へご招待いただきました`
    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Meiryo,sans-serif;font-size:14px;color:#111;line-height:1.75;max-width:560px;margin:0 auto;padding:8px;">
  <p style="margin:0 0 12px;">お世話になっております。NodeCloud 事務局です。</p>
  <p style="margin:0 0 12px;">
    このたび <strong>${inviterEsc}</strong> 様より、お客様を NodeCloud の組織
    <strong>「${orgNameEsc}」</strong> の <strong>${roleLabelEsc}</strong>
    としてご招待いただきました。
  </p>
  <p style="margin:16px 0 8px;">下記のリンクからアカウント登録・ログインを行っていただくと、当該組織に紐づく現場情報の閲覧・編集等をご利用いただけます。</p>
  <p style="margin:0 0 16px;">
    <a href="${linkEsc}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
      招待を受ける
    </a>
  </p>
  <p style="color:#666;font-size:12px;margin:0 0 16px;">
    リンクが開かない場合は、下記 URL をブラウザに貼り付けてご利用ください。<br />
    ${linkEsc}
  </p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:13px;">
    <div style="color:#64748b;margin-bottom:4px;">■ 詳細</div>
    <div>組織名: <strong>${orgNameEsc}</strong></div>
    <div>権限: <strong>${roleLabelEsc}</strong></div>
    <div>招待者: ${inviterEsc}</div>
  </div>
  <p style="color:#666;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px;">
    本メールにお心当たりが無い場合は、恐れ入りますがそのまま破棄いただきますようお願いいたします。
  </p>
  <p style="color:#94a3b8;font-size:12px;margin:4px 0 0;">NodeCloud 事務局</p>
</div>
    `
    await sendResendMail({ to: toEmail, subject, html })
  }

  // 既にアプリに登録済みのユーザーを組織に追加した際に「追加されました」
  // 通知メールを Resend 経由で送る (Supabase Invite は再登録扱いになって
  // しまうため既存ユーザーには使えない)。RESEND_API_KEY が無ければ黙ってスキップ。
  async function sendOrgAddedNotification(
    toEmail: string,
    orgName: string,
    inviterEmail: string,
  ) {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      console.warn('[invite-member] RESEND_API_KEY not set, skipping org-added notification')
      return
    }
    const from = Deno.env.get('NOTIFY_FROM') ?? 'NodeCloud <onboarding@resend.dev>'
    const loginUrl = redirectBase ? redirectBase.replace(/\/$/, '') : ''
    const subject = `【NodeCloud】組織「${orgName}」のメンバーに追加されました`
    const orgNameEsc = escapeHtml(orgName)
    const inviterEsc = escapeHtml(inviterEmail)
    const loginUrlEsc = escapeHtml(loginUrl)
    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Meiryo,sans-serif;font-size:14px;color:#111;line-height:1.75;max-width:560px;margin:0 auto;padding:8px;">
  <p style="margin:0 0 12px;">お世話になっております。NodeCloud 事務局です。</p>
  <p style="margin:0 0 12px;">
    このたび <strong>${inviterEsc}</strong> 様より、お客様を NodeCloud の組織
    <strong>「${orgNameEsc}」</strong> のメンバーとしてご追加いただきました。<br />
    今後、当該組織に紐づく現場情報の閲覧・編集等をご利用いただけます。
  </p>
  ${
    loginUrl
      ? `<p style="margin:16px 0 8px;">下記のリンクよりログインのうえ、ご確認ください。</p>
         <p style="margin:0 0 16px;">
           <a href="${loginUrlEsc}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
             NodeCloud を開く
           </a>
         </p>
         <p style="color:#666;font-size:12px;margin:0 0 16px;">
           リンクが開かない場合は、下記 URL をブラウザに貼り付けてご利用ください。<br />
           ${loginUrlEsc}
         </p>`
      : ''
  }
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:13px;">
    <div style="color:#64748b;margin-bottom:4px;">■ 詳細</div>
    <div>組織名: <strong>${orgNameEsc}</strong></div>
    <div>招待者: ${inviterEsc}</div>
  </div>
  <p style="color:#666;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px;">
    本メールにお心当たりが無い場合は、恐れ入りますがそのまま破棄いただきますようお願いいたします。
  </p>
  <p style="color:#94a3b8;font-size:12px;margin:4px 0 0;">NodeCloud 事務局</p>
</div>
    `
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: toEmail, subject, html }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Resend ${res.status}: ${text}`)
    }
  }

  // 既存ユーザーをプロジェクト共有メンバーに追加した際の通知メール。
  // 組織版と同じく Supabase Invite は使えないため Resend 経由。
  // メール内には「現場を直接開くリンク」「トップページのリンク」を両方掲載。
  async function sendProjectAddedNotification(
    toEmail: string,
    projectId: string,
    projectName: string,
    inviterEmail: string,
    role: ProjectRole,
  ) {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      console.warn('[invite-member] RESEND_API_KEY not set, skipping project-added notification')
      return
    }
    const from = Deno.env.get('NOTIFY_FROM') ?? 'NodeCloud <onboarding@resend.dev>'
    const base = redirectBase ? redirectBase.replace(/\/$/, '') : ''
    const topUrl = base
    const projectUrl = base ? `${base}/projects/${projectId}` : ''
    const roleLabel =
      role === 'owner' ? '管理者' : role === 'editor' ? '編集者' : '閲覧者'
    const subject = `【NodeCloud】現場「${projectName}」の共有メンバーに追加されました`

    const projectNameEsc = escapeHtml(projectName)
    const inviterEsc = escapeHtml(inviterEmail)
    const roleLabelEsc = escapeHtml(roleLabel)
    const topUrlEsc = escapeHtml(topUrl)
    const projectUrlEsc = escapeHtml(projectUrl)

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Meiryo,sans-serif;font-size:14px;color:#111;line-height:1.75;max-width:560px;margin:0 auto;padding:8px;">
  <p style="margin:0 0 12px;">お世話になっております。NodeCloud 事務局です。</p>
  <p style="margin:0 0 12px;">
    このたび <strong>${inviterEsc}</strong> 様より、お客様を NodeCloud の現場
    <strong>「${projectNameEsc}」</strong> の <strong>${roleLabelEsc}</strong>
    として共有メンバーにご追加いただきました。
  </p>
  ${
    projectUrl || topUrl
      ? `<p style="margin:16px 0 8px;">下記のリンクからご確認いただけます。</p>
         <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
           <tr>
             ${
               projectUrl
                 ? `<td style="padding:0 8px 8px 0;">
                      <a href="${projectUrlEsc}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
                        現場「${projectNameEsc}」を開く
                      </a>
                    </td>`
                 : ''
             }
             ${
               topUrl
                 ? `<td style="padding:0 0 8px 0;">
                      <a href="${topUrlEsc}" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#111;text-decoration:none;border-radius:6px;border:1px solid #cbd5e1;font-weight:600;">
                        トップページを開く
                      </a>
                    </td>`
                 : ''
             }
           </tr>
         </table>
         <p style="color:#666;font-size:12px;margin:0 0 16px;">
           リンクが開かない場合は、下記 URL をブラウザに貼り付けてご利用ください。<br />
           ${projectUrl ? `現場: ${projectUrlEsc}<br />` : ''}
           ${topUrl ? `トップ: ${topUrlEsc}` : ''}
         </p>`
      : ''
  }
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:13px;">
    <div style="color:#64748b;margin-bottom:4px;">■ 詳細</div>
    <div>現場名: <strong>${projectNameEsc}</strong></div>
    <div>権限: <strong>${roleLabelEsc}</strong></div>
    <div>招待者: ${inviterEsc}</div>
  </div>
  <p style="color:#666;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px;">
    本メールにお心当たりが無い場合は、恐れ入りますがそのまま破棄いただきますようお願いいたします。
  </p>
  <p style="color:#94a3b8;font-size:12px;margin:4px 0 0;">NodeCloud 事務局</p>
</div>
    `
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: toEmail, subject, html }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Resend ${res.status}: ${text}`)
    }
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
      let roleChanged = false
      let newlyAdded = false
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
          roleChanged = true
        }
      } else {
        const { error } = await admin
          .from('project_members')
          .insert({ project_id: projectId, user_id: existingUserId, role })
        if (error) {
          return json(500, { error: 'Member insert failed: ' + error.message }, origin)
        }
        newlyAdded = true
      }

      // 通知メール: 新規追加 or ロール変更のあった時だけ送る (何もしなかったら送らない)
      let notified = false
      let notifyError: string | null = null
      if (newlyAdded || roleChanged) {
        try {
          const { data: projRow } = await admin
            .from('projects')
            .select('name')
            .eq('id', projectId)
            .maybeSingle()
          const projectName = (projRow as { name?: string } | null)?.name ?? '現場'
          await sendProjectAddedNotification(
            emailRaw,
            projectId,
            projectName,
            callerEmail,
            role,
          )
          notified = true
        } catch (err) {
          notifyError = (err as Error).message
          console.warn('[invite-member] project-added notification failed:', notifyError)
        }
      }
      return json(
        200,
        { ok: true, status: 'added_existing_user', notified, notify_error: notifyError },
        origin,
      )
    }

    // 未登録 → pending_invitations に upsert し、Resend で招待メール送信
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
    // メール本文に現場名を入れるため fetch (取れなければ '現場' で妥協)
    const { data: projRow } = await admin
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .maybeSingle()
    const projectName = (projRow as { name?: string } | null)?.name ?? '現場'
    try {
      await sendProjectInviteEmail(emailRaw, projectName, callerEmail, role)
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

  // 既存ユーザー検索 (email 優先、無ければ phone)
  let existingUserId: string | null = null
  try {
    if (emailRaw) {
      existingUserId = await findUserIdByEmail(emailRaw)
    }
    if (!existingUserId && phoneRaw) {
      existingUserId = await findUserIdByPhone(phoneRaw)
    }
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

    // 既存ユーザーに「組織に追加されました」通知メールを送る。
    // email が無いユーザー (phone 招待) は通知メールをスキップ。
    let notified = false
    let notifyError: string | null = null
    if (emailRaw) {
      try {
        const { data: orgRow } = await admin
          .from('organizations')
          .select('name')
          .eq('id', orgId)
          .maybeSingle()
        const orgName = (orgRow as { name?: string } | null)?.name ?? '組織'
        await sendOrgAddedNotification(emailRaw, orgName, callerEmail)
        notified = true
      } catch (err) {
        notifyError = (err as Error).message
        console.warn('[invite-member] org-added notification failed:', notifyError)
      }
    }
    return json(
      200,
      { ok: true, status: 'added_existing_user', notified, notify_error: notifyError },
      origin,
    )
  }

  // 未登録 → pending_invitations に upsert
  //   email 招待: onConflict: 'organization_id,email'
  //   phone 招待: onConflict: 'organization_id,phone'
  //   両方あるケースは email 優先。
  const conflictKey = emailRaw ? 'organization_id,email' : 'organization_id,phone'
  const { error: pendErr } = await admin
    .from('pending_invitations')
    .upsert(
      {
        organization_id: orgId,
        email: emailRaw,
        phone: phoneRaw,
        org_role: orgRole,
        invited_by: callerId,
      },
      { onConflict: conflictKey },
    )
  if (pendErr) {
    return json(500, { error: 'Pending insert failed: ' + pendErr.message }, origin)
  }

  // email 招待: Resend で招待メール送信
  // phone 招待: SMS 送信は Supabase Auth の signInWithOtp 経由で
  //   ユーザーがログイン試行した時に自動で走る。ここでは通知しない。
  if (emailRaw) {
    const { data: orgRowForMail } = await admin
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .maybeSingle()
    const orgNameForMail = (orgRowForMail as { name?: string } | null)?.name ?? '組織'
    try {
      await sendOrgInviteEmail(emailRaw, orgNameForMail, callerEmail, orgRole)
    } catch (err) {
      return json(500, { error: 'Invite send failed: ' + (err as Error).message }, origin)
    }
  }
  return json(
    200,
    {
      ok: true,
      status: emailRaw ? 'invited' : 'invited_by_phone',
      /** phone 招待は、ユーザーが自分で電話番号でログインしに来る必要がある旨を UI に伝える */
      note: phoneRaw
        ? '電話番号での招待を受け付けました。招待された方がアプリで電話番号ログインをすると自動的に組織に追加されます。'
        : undefined,
    },
    origin,
  )
})
