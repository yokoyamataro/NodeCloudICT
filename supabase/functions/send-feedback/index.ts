// ログイン中のユーザーから運営者へ意見・要望を送るための Edge Function。
//
// 動作:
//   1. 呼び出し元の JWT を検証し、auth.users から email を取得（差出人の身元を保証）。
//   2. 本文 message と画像添付（base64）を Resend にそのまま流して NOTIFY_TO 宛にメール送信。
//
// 必要な環境変数（supabase secrets set ...）:
//   RESEND_API_KEY                ... Resend の API キー（必須）
//   NOTIFY_TO                     ... 通知先メール（省略時 yokoyama1980@gmail.com）
//   NOTIFY_FROM                   ... 送信元（省略時 onboarding@resend.dev）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ... runtime で既定提供
//
// デプロイ: supabase functions deploy send-feedback

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface AttachmentIn {
  filename?: string
  // data URL（"data:image/jpeg;base64,..."）または素の base64 のいずれも受ける
  content?: string
  mime?: string
}

interface FeedbackBody {
  message?: string
  attachments?: AttachmentIn[]
  userAgent?: string
  pageUrl?: string
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

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

// 添付の合計サイズ（base64 デコード前）に上限を設けて Resend の 40MB 制限を超えないようにする。
// base64 は約 4/3 に膨らむので 25MB を上限にしておけば実体 ~33MB まで（メール本文も含めて余裕あり）。
const MAX_TOTAL_BASE64 = 25 * 1024 * 1024

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) return json(500, { error: 'Server not configured (RESEND_API_KEY)' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: 'Server not configured (Supabase keys)' })
  }

  // 呼び出し元の JWT を取り出して uid と email を確定
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) return json(401, { error: 'Not authenticated' })

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData?.user) return json(401, { error: 'Invalid token' })
  const senderEmail = callerData.user.email ?? '(no email)'
  const senderId = callerData.user.id

  let body: FeedbackBody = {}
  try {
    body = (await req.json()) as FeedbackBody
  } catch {
    return json(400, { error: 'Bad Request' })
  }

  const message = String(body.message ?? '').trim()
  if (!message) return json(400, { error: 'message が必要です' })
  if (message.length > 10000) return json(400, { error: 'message が長すぎます' })

  // 添付を Resend 形式へ整形しつつサイズ検証
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
  let totalBase64 = 0
  const attachments: { filename: string; content: string }[] = []
  for (let i = 0; i < rawAttachments.length; i++) {
    const a = rawAttachments[i]
    const raw = String(a?.content ?? '')
    if (!raw) continue
    // data URL であれば base64 部分だけ抜き出す
    const base64 = raw.startsWith('data:') ? raw.replace(/^data:[^;]+;base64,/, '') : raw
    totalBase64 += base64.length
    if (totalBase64 > MAX_TOTAL_BASE64) {
      return json(413, { error: '添付の合計サイズが大きすぎます（25MB まで）' })
    }
    const ext =
      a?.mime === 'image/png' ? 'png' :
      a?.mime === 'image/webp' ? 'webp' :
      'jpg'
    attachments.push({
      filename: (a?.filename && String(a.filename).trim()) || `image-${i + 1}.${ext}`,
      content: base64,
    })
  }

  const to = Deno.env.get('NOTIFY_TO') ?? 'yokoyama1980@gmail.com'
  const from = Deno.env.get('NOTIFY_FROM') ?? 'NodeCloud <onboarding@resend.dev>'

  const subject = `【NodeCloud 意見・要望】${senderEmail}`
  const html = `
    <h2>意見・要望</h2>
    <table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>差出人</b></td><td>${esc(senderEmail)}</td></tr>
      <tr><td><b>uid</b></td><td>${esc(senderId)}</td></tr>
      <tr><td><b>ページ</b></td><td>${esc(body.pageUrl)}</td></tr>
      <tr><td><b>UA</b></td><td>${esc(body.userAgent)}</td></tr>
      <tr><td><b>受付</b></td><td>${esc(new Date().toISOString())}</td></tr>
    </table>
    <h3>本文</h3>
    <div style="padding:8px;border:1px solid #ddd;background:#fafafa">${esc(message)}</div>
  `

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      reply_to: senderEmail !== '(no email)' ? senderEmail : undefined,
      attachments: attachments.length ? attachments : undefined,
    }),
  })

  if (!resendRes.ok) {
    const text = await resendRes.text()
    console.error('Resend 送信失敗', resendRes.status, text)
    return json(502, { error: `Resend error: ${resendRes.status}` })
  }

  return json(200, { ok: true })
})
