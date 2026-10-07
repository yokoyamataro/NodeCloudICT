// 座標 OCR API (Vercel Serverless Function)。
//
// POST /api/ocr-coordinates
//   body: { files: Array<{ mimeType: string; dataBase64: string }>, hint?: string }
//   resp: { points: Array<{ pointNumber, x, y, z, type?, confidence? }> }
//
// 画像 / PDF を Claude Vision に 投げて 構造化 JSON を 返させる。
// 日本 の 平面直角座標 を 前提 と して プロンプト を 書く:
//   X = 北方向、 Y = 東方向、 負値 を 含む こと が ある。
//
// 環境変数:
//   ANTHROPIC_API_KEY  - Claude API キー (必須)
//
// 対応 形式:
//   - 画像: image/jpeg, image/png, image/webp, image/gif
//   - PDF:  application/pdf (Claude が ネイティブ 対応)
//
// 出力 形式 (points の 各要素):
//   pointNumber: string           — 点番号 (必須)
//   x: number                     — X 座標 [m] (北 方向、 必須)
//   y: number                     — Y 座標 [m] (東 方向、 必須)
//   z: number | null              — 標高 [m] (無ければ null)
//   type: string | null           — 点種 (control / boundary / underdrain / 等)、 不明 なら null
//   confidence: number            — 読取 信頼度 (0-1)、 低値 は UI で 警告 表示

interface FilePart {
  mimeType: string
  dataBase64: string
}

interface OcrRequest {
  files?: FilePart[]
  /** 「縦並び」「横並び」等 の 形式 ヒント (任意) */
  hint?: string
}

interface OcrPoint {
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: string | null
  confidence: number
}

interface SuccessResponse {
  points: OcrPoint[]
  model?: string
  usageInputTokens?: number
  usageOutputTokens?: number
}

interface ErrorResponse {
  error: string
  detail?: string
}

const SYSTEM_PROMPT = `あなた は 日本 の 測量 座標表 の OCR 専門 アシスタント です。
入力 の 画像 / PDF から 点番号 と 座標 を 抽出 して 構造化 JSON を 返します。

ルール:
- 日本 の 平面直角座標系 を 前提 と します。 X = 北 方向、 Y = 東 方向。
  どちら も 負 の 値 を 取り 得る (例: X=-9748.928, Y=33787.204)。
- 表 の 列順 が 「X, Y」 の 時 も 「Y, X」 の 時 も あります。 ヘッダ が
  あれば ヘッダ に 従って ください。
- 表 は 縦並び (1 行 = 1 点) の 他、 横並び (列 ごと に 点) も あります。
  レイアウト は 自動 で 判断 して ください。
- 点番号 は 「K1」「1A」「K3-3」「境界点1」 等 の 自由 な 書式。
- Z (標高) は あれば 読む、 無ければ null。
- 種別 (type) は 以下 から 推測:
    control (基準点) / boundary (境界点) / current (現況) / measured (実測点) /
    underdrain (暗渠) / tombo (トンボ) / chohari (丁張) / width_stake (幅杭)
  読み取れ なけれ ば null。
- 符号 の 「-」 が 「ー」 (長音) に 化け て いる 場合 は 「-」 と 復元。
- 読取 自信 が 低い 行 は confidence を 0.5 未満 に。 完全 に 読め ない 行 は 省略。
- 装飾 情報 (タイトル / 枠線 / スケッチ / メモ) は 無視。 座標 の 行 のみ 返す。

出力 形式 は 必ず 以下 の JSON の のみ (他 の 文字 は 一切 付け ない):
{
  "points": [
    { "pointNumber": "K1", "x": 3625.987, "y": -27701.924, "z": 0.000, "type": "control", "confidence": 0.95 }
  ]
}`

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929'

/** Claude Messages API の コンテンツ ブロック 型 (必要 分 のみ) */
type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }
  | {
      type: 'document'
      source: { type: 'base64'; media_type: 'application/pdf'; data: string }
    }

export default async function handler(
  req: { method?: string; body?: OcrRequest | string },
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
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.status(500).json({
      error: 'ANTHROPIC_API_KEY が 設定 されて いません',
      detail: 'Vercel の 環境変数 に Anthropic Claude の API キー を 設定 して ください',
    })
    return
  }

  let body: OcrRequest = {}
  try {
    body = typeof req.body === 'string' ? (JSON.parse(req.body) as OcrRequest) : req.body ?? {}
  } catch {
    res.status(400).json({ error: 'Invalid JSON' })
    return
  }

  const files = body.files ?? []
  if (files.length === 0) {
    res.status(400).json({ error: '画像 / PDF ファイル が ありません' })
    return
  }
  // 1 リクエスト あたり ファイル は 多すぎ ない よう 制限
  if (files.length > 10) {
    res.status(400).json({ error: 'ファイル は 最大 10 件 まで です' })
    return
  }

  const content: ContentBlock[] = []
  for (const f of files) {
    if (!f.dataBase64 || !f.mimeType) continue
    if (f.mimeType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: f.dataBase64 },
      })
    } else if (f.mimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: f.mimeType, data: f.dataBase64 },
      })
    }
    // それ 以外 (text/* 等) は 無視
  }
  if (content.length === 0) {
    res.status(400).json({ error: '取り込める 画像 / PDF が ありません' })
    return
  }

  const userText =
    (body.hint ? `形式 ヒント: ${body.hint}\n\n` : '') +
    '上記 の 画像 / PDF から 座標 を 読み取り、 指定 の JSON 形式 で 返して ください。'
  content.push({ type: 'text', text: userText })

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    })
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.status(502).json({
        error: `Claude API error ${upstream.status}`,
        detail: text.slice(0, 500),
      })
      return
    }
    const resp = (await upstream.json()) as {
      content?: Array<{ type: string; text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const textOut =
      resp.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? ''

    // Claude は たま に ```json ... ``` で 囲む の で 剥がす
    const stripped = stripCodeFence(textOut).trim()
    let parsed: { points?: unknown } = {}
    try {
      parsed = JSON.parse(stripped) as { points?: unknown }
    } catch {
      res.status(502).json({
        error: 'Claude の 返答 が JSON と して 読め ません でした',
        detail: textOut.slice(0, 500),
      })
      return
    }
    const points = normalizePoints(parsed.points)
    res.status(200).json({
      points,
      model: CLAUDE_MODEL,
      usageInputTokens: resp.usage?.input_tokens,
      usageOutputTokens: resp.usage?.output_tokens,
    })
  } catch (err) {
    console.error('[ocr-coordinates] fetch failed', err)
    res.status(500).json({
      error: 'Claude API 呼び出し に 失敗 しました',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

function stripCodeFence(s: string): string {
  // ``` or ```json で 囲まれた 部分 を 中身 だけ 取り出す
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  return m ? m[1] : s
}

/** 返答 の points 配列 を 安全 な 型 に 整える。 不正 な 行 は skip */
function normalizePoints(raw: unknown): OcrPoint[] {
  if (!Array.isArray(raw)) return []
  const out: OcrPoint[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const obj = r as Record<string, unknown>
    const name = typeof obj.pointNumber === 'string' ? obj.pointNumber.trim() : ''
    const x = Number(obj.x)
    const y = Number(obj.y)
    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue
    const z = obj.z == null ? null : Number(obj.z)
    const type = typeof obj.type === 'string' && obj.type.trim() !== '' ? obj.type : null
    const confidenceRaw = Number(obj.confidence)
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.8
    out.push({
      pointNumber: name,
      x,
      y,
      z: z != null && Number.isFinite(z) ? z : null,
      type,
      confidence,
    })
  }
  return out
}
