// お問い合わせ 受信 API (Vercel Serverless Function).
//
// POST /api/contact
//   body: { topic, name, company, email, phone, message }
//   resp: { ticketId: "NC-YYYYMMDD-NNNN" }
//
// 動き:
//   1. バリデーション (name/email/message 必須、 メール 形式)
//   2. 受付番号 を 生成 (NC-YYYYMMDD-NNNN、 日付 ごと に カウント)
//   3. 社内 通知 と 自動返信 を Resend で 送信 (環境変数 未設定 なら ログ だけ)
//   4. 自動返信 テンプレ は api/_templates/auto-reply.{html,txt} を 使う
//
// 環境変数 (Vercel の プロジェクト 設定):
//   RESEND_API_KEY       - Resend の API キー。 未設定 なら 送信 を スキップ
//   CONTACT_FROM_EMAIL   - 送信元 アドレス。 例: noreply@nodecloud.jp
//   CONTACT_TO_EMAIL     - 社内 通知先。 例: support@nodecloud.jp
//   CONTACT_PHONE        - 自動返信 に 載せる 電話番号。 例: 0152-23-1311
//   CONTACT_ADDRESS      - 自動返信 に 載せる 住所
//
// TODO(未確定):
//   - 受付番号 の カウンタ は メモリ 内。 サーバレス で は インスタンス 間 共有 されない ので、
//     本番 では Supabase の カウンタ テーブル or Redis に 置き換える。
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

  const ticketId = makeTicketId()
  const receivedAt = receivedAtJst()

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
