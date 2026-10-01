// お問い合わせ 受信 API (Vercel Serverless Function).
//
// POST /api/contact
//   body: { topic, name, company, email, phone, message }
//   resp: { ticketId: "NC-YYYYMMDD-NNNN" }
//
// 動き:
//   1. バリデーション (name/email/message 必須、 メール 形式)
//   2. Supabase (contact_messages) に INSERT し、 ticket_id を 受け取る
//      (ticket_id 自体 は API 側 で 生成。 DB の UNIQUE 制約 で 衝突 を 弾く)
//   3. 社内 通知 と 自動返信 を Resend で 送信 (環境変数 未設定 なら ログ だけ)
//   4. 自動返信 テンプレ は api/_templates/auto-reply.{html,txt} を 使う
//
// 環境変数 (Vercel の プロジェクト 設定):
//   SUPABASE_URL                 - Supabase プロジェクト URL。 無ければ
//                                   VITE_SUPABASE_URL (クライアント 公開 用) を 流用。
//   SUPABASE_SERVICE_ROLE_KEY    - service role キー。 RLS を バイパス して 書き込む。
//                                   anon キー では ダメ (INSERT が RLS で 弾かれる)。
//                                   未設定 なら DB 保存 は スキップ (メール だけ 送る)。
//   RESEND_API_KEY               - Resend の API キー。 未設定 なら 送信 を スキップ
//   CONTACT_FROM_EMAIL           - 送信元。 例: noreply@nodecloud.jp
//   CONTACT_TO_EMAIL             - 社内 通知先。 例: support@nodecloud.jp
//   CONTACT_PHONE                - 自動返信 に 載せる 電話番号
//   CONTACT_ADDRESS              - 自動返信 に 載せる 住所
//
// TODO(未確定):
//   - 連番 の 当日 ぶん カウンタ は メモリ 内。 衝突時 は DB の UNIQUE で 弾いて
//     リトライ する。 高 頻度 な ら Supabase の sequence に 寄せる 検討。
//   - スパム 対策 を 強化 する なら Turnstile を 入れる

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface ContactPayload {
  topic?: string
  name?: string
  company?: string
  email?: string
  phone?: string
  message?: string
}

interface SuccessResponse {
  ticketId: string
}

interface ErrorResponse {
  error: string
}

// 受付番号 の 当日 ぶん 連番。 サーバレス では インスタンス を 跨ぐ と リセット される。
// 本番 で 一意性 を 担保 したい 場合 は 永続 ストレージ に 切り替える (TODO 参照)。
let dailyCounter: { date: string; n: number } = { date: '', n: 0 }

function todayJst(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

function makeTicketId(): string {
  const today = todayJst()
  if (dailyCounter.date !== today) dailyCounter = { date: today, n: 0 }
  dailyCounter.n += 1
  return `NC-${today}-${String(dailyCounter.n).padStart(4, '0')}`
}

function receivedAtJst(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${y}/${m}/${dd} ${hh}:${mi}`
}

function fillTemplate(src: string, vars: Record<string, string>): string {
  return src.replace(/{{\s*(\w+)\s*}}/g, (_, k: string) => vars[k] ?? '')
}

/**
 * Supabase (contact_messages) に 問い合わせ を 残す。
 * SERVICE_ROLE_KEY 未設定 な ら DB 保存 を 諦め、 ticket_id だけ 返す
 * (メール 送信 は 試行 する ので、 社内 通知 で 失注 は 防げる)。
 * UNIQUE 衝突 (同じ ticket_id) は 呼び 側 で 再生成 して リトライ できる よう エラー 投げる。
 */
async function insertContactRow(args: {
  ticketId: string
  topic: string
  name: string
  company: string
  email: string
  phone: string
  message: string
  userAgent: string
  ipAddress: string
}): Promise<boolean> {
  // VITE_SUPABASE_URL は クライアント ビルド 用 の 公開 変数 だが 値 は 同じ URL なので
  // サーバ 側 でも フォールバック として 使う。 service role キー は 必ず 専用変数 を 要求。
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('[contact] SUPABASE_SERVICE_ROLE_KEY 未設定 のため DB 保存 を スキップ')
    return false
  }
  const res = await fetch(`${url}/rest/v1/contact_messages`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      ticket_id: args.ticketId,
      topic: args.topic,
      name: args.name,
      company: args.company || null,
      email: args.email,
      phone: args.phone || null,
      message: args.message,
      user_agent: args.userAgent || null,
      ip_address: args.ipAddress || null,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase insert ${res.status}: ${body}`)
  }
  return true
}

async function sendEmail(args: {
  from: string
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
}): Promise<void> {
  const key = process.env.RESEND_API_KEY
  if (!key) {
    // キー 未設定 (開発 / preview) は 送信 せず に ログ だけ 出す。 UI は 成功 扱い。
    console.log('[contact] RESEND_API_KEY 未設定 のため メール 送信 を スキップ:', {
      to: args.to,
      subject: args.subject,
    })
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      reply_to: args.replyTo,
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Resend API error ${res.status}: ${t}`)
  }
}

export default async function handler(
  req: { method?: string; body?: ContactPayload | string; headers?: Record<string, string> },
  res: {
    status: (code: number) => {
      json: (data: SuccessResponse | ErrorResponse) => void
    }
    setHeader?: (k: string, v: string) => void
  },
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  let body: ContactPayload = {}
  try {
    body = typeof req.body === 'string' ? (JSON.parse(req.body) as ContactPayload) : req.body ?? {}
  } catch {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }

  const name = (body.name ?? '').trim()
  const email = (body.email ?? '').trim()
  const message = (body.message ?? '').trim()
  const topic = (body.topic ?? '').trim() || 'お問い合わせ'
  const company = (body.company ?? '').trim()
  const phone = (body.phone ?? '').trim()

  if (!name || !email || !message) {
    res.status(400).json({ error: 'お名前・メールアドレス・内容は必須です。' })
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'メールアドレスの形式が正しくありません。' })
    return
  }
  if (name.length > 100 || email.length > 200 || message.length > 5000) {
    res.status(400).json({ error: '入力が長すぎます。' })
    return
  }

  // UA / IP は ログ 用。 Vercel の req には x-forwarded-for が 付いて 来る。
  const headers = req.headers ?? {}
  const userAgent = (headers['user-agent'] ?? '') + ''
  const ipAddress = ((headers['x-forwarded-for'] ?? '') + '').split(',')[0].trim()

  // DB の UNIQUE 衝突 (まれ) に 備えて 3 回 まで リトライ して ticket_id を 発番 する
  let ticketId = ''
  let dbSaved = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ticketId = makeTicketId()
    try {
      dbSaved = await insertContactRow({
        ticketId,
        topic,
        name,
        company,
        email,
        phone,
        message,
        userAgent,
        ipAddress,
      })
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 23505 = unique_violation。 その 時 だけ 連番 を 進めて リトライ。
      if (/23505|duplicate key/i.test(msg) && attempt < 2) {
        console.warn('[contact] ticket_id 衝突。 リトライ:', ticketId)
        continue
      }
      // それ 以外 の DB エラー は 握りつぶして メール だけ 送る (ユーザ 体験 優先)。
      console.error('[contact] DB 保存 失敗:', err)
      dbSaved = false
      break
    }
  }
  const receivedAt = receivedAtJst()
  // dbSaved は 現状 ログ 用 のみ。 将来 「DB 必須」 に したい なら ここ で 500 を 返す。
  void dbSaved

  // 自動返信 テンプレ を 読み込ん で 変数 を 差し込む。
  // 本番 ビルド (Vercel) で は この ファイル が 関数 と 同じ ルート に 配置 される 想定。
  const tplDir = join(process.cwd(), 'api', '_templates')
  let htmlTpl: string
  let txtTpl: string
  try {
    htmlTpl = readFileSync(join(tplDir, 'auto-reply.html'), 'utf8')
    txtTpl = readFileSync(join(tplDir, 'auto-reply.txt'), 'utf8')
  } catch (e) {
    console.error('[contact] テンプレート 読込 失敗:', e)
    res.status(500).json({ error: 'テンプレート読込に失敗しました。' })
    return
  }

  const vars: Record<string, string> = {
    company: company || '',
    name,
    ticket_id: ticketId,
    topic,
    received_at: receivedAt,
    message,
    phone: process.env.CONTACT_PHONE ?? '0152-23-1311',
    address: process.env.CONTACT_ADDRESS ?? '北海道斜里郡斜里町青葉町9番地13',
  }

  const html = fillTemplate(htmlTpl, vars)
  const text = fillTemplate(txtTpl, vars)
  const subject = `【NodeCloud】お問い合わせを受け付けました（受付番号：${ticketId}）`

  const from = process.env.CONTACT_FROM_EMAIL ?? 'noreply@nodecloud.jp'
  const notifyTo = process.env.CONTACT_TO_EMAIL ?? 'support@nodecloud.jp'

  try {
    // 1. 自動返信 (送信者 へ)
    await sendEmail({ from, to: email, subject, html, text })
    // 2. 社内 通知 (運用 窓口 へ)。 reply-to を 問い合わせ者 に 向け て そのまま 返信 可能 に する。
    const notifyText =
      `受付番号: ${ticketId}\n受付日時: ${receivedAt}\n\n` +
      `お名前: ${name}\n会社: ${company || '(未入力)'}\n` +
      `メール: ${email}\n電話: ${phone || '(未入力)'}\n` +
      `ご用件: ${topic}\n\n内容:\n${message}\n`
    await sendEmail({
      from,
      to: notifyTo,
      replyTo: email,
      subject: `[NodeCloud 問合せ] ${ticketId} / ${name} / ${topic}`,
      html: `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${notifyText.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</pre>`,
      text: notifyText,
    })
  } catch (err) {
    console.error('[contact] メール 送信 失敗:', err)
    // 送信 失敗 でも 受付 自体 は 成立 (ログ で 復旧 可能)。 Resend 未設定 の 開発 環境 で も UX を 保つ。
    res.status(200).json({ ticketId })
    return
  }

  res.status(200).json({ ticketId })
}
