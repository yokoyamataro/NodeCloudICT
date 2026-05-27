// signup_requests への INSERT を Database Webhook で受け取り、Resend でメール通知する Edge Function。
//
// 必要な環境変数（supabase secrets set ...）:
//   RESEND_API_KEY   ... Resend の API キー（必須）
//   NOTIFY_TO        ... 通知先メール（省略時 yokoyama1980@gmail.com）
//   NOTIFY_FROM      ... 送信元（省略時 onboarding@resend.dev＝ドメイン未設定でも可）
//   WEBHOOK_SECRET   ... 任意。設定するとヘッダ x-webhook-secret と照合して不正呼び出しを防ぐ
//
// デプロイ: supabase functions deploy notify-signup --no-verify-jwt

interface SignupRecord {
  company_name?: string
  contact_name?: string
  email?: string
  phone?: string | null
  user_count?: number | null
  plan_interest?: string | null
  message?: string | null
  created_at?: string
}

const PLAN_LABEL: Record<string, string> = {
  civil: '農業土木',
  boundary: '境界測量（不動産・士業）',
  undecided: '未定 / 相談',
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // 任意のシークレット照合
  const secret = Deno.env.get('WEBHOOK_SECRET')
  if (secret && req.headers.get('x-webhook-secret') !== secret) {
    return new Response('Forbidden', { status: 403 })
  }

  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    console.error('RESEND_API_KEY が未設定です')
    return new Response('Server not configured', { status: 500 })
  }
  const to = Deno.env.get('NOTIFY_TO') ?? 'yokoyama1980@gmail.com'
  const from = Deno.env.get('NOTIFY_FROM') ?? 'NodeCloud <onboarding@resend.dev>'

  let rec: SignupRecord = {}
  try {
    const body = await req.json()
    // Database Webhook の形 { type, table, record } / 直接 record の両方に対応
    rec = (body?.record ?? body) as SignupRecord
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const planLabel = rec.plan_interest ? PLAN_LABEL[rec.plan_interest] ?? rec.plan_interest : '-'
  const subject = `【NodeCloud】新規お申し込み: ${rec.company_name ?? '(会社名なし)'}`
  const html = `
    <h2>新規お申し込み / お問い合わせ</h2>
    <table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>会社名</b></td><td>${esc(rec.company_name)}</td></tr>
      <tr><td><b>担当者</b></td><td>${esc(rec.contact_name)}</td></tr>
      <tr><td><b>メール</b></td><td>${esc(rec.email)}</td></tr>
      <tr><td><b>電話</b></td><td>${esc(rec.phone)}</td></tr>
      <tr><td><b>想定人数</b></td><td>${esc(rec.user_count)}</td></tr>
      <tr><td><b>興味プラン</b></td><td>${esc(planLabel)}</td></tr>
      <tr><td><b>要望</b></td><td>${esc(rec.message)}</td></tr>
      <tr><td><b>受付日時</b></td><td>${esc(rec.created_at)}</td></tr>
    </table>
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
      reply_to: rec.email || undefined,
    }),
  })

  if (!resendRes.ok) {
    const text = await resendRes.text()
    console.error('Resend 送信失敗', resendRes.status, text)
    return new Response(`Resend error: ${resendRes.status}`, { status: 502 })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
