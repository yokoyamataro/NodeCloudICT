// サイトオーナー限定: 登記情報 PDF を Claude Haiku 4.5 に投げて、構造化 JSON
// (所在 / 地番 / 地目 / 地積 / 所有者一覧) として抽出する。
//
// なぜ AI を使うか:
//   全部事項 の PDF は相続 / 売買 / 共有 / 会社所有 / 分筆・合筆履歴 等で
//   レイアウトが千差万別。正規表現で全パターンを追いかけると保守が破綻するため、
//   Claude に PDF を直接読ませて必要フィールドだけ tool_use で吐かせる。
//
// 必要な環境変数 (Supabase secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto)
//   ANTHROPIC_API_KEY  <- Anthropic Console で発行して supabase secrets set で登録
//
// デプロイ: supabase functions deploy parse-registry-pdf

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 2048

interface ParseBody {
  pdf_base64?: string
  kind?: 'ownership' | 'full'
  /** ヒント: ファイル名 / touki.or.jp 側で分かっている所在・地番 (LLM に補助情報として渡す) */
  hint?: {
    location?: string | null
    parcel_number?: string | null
    file_name?: string | null
  }
}

interface ExtractedOwner {
  name: string
  address: string
  /** 共有持分 (例: "1/2") — 単有なら未設定 */
  share?: string | null
}

interface Extracted {
  location: string | null
  parcel_number: string | null
  land_category: string | null
  area_sqm: number | null
  owners: ExtractedOwner[]
  confidence: number
  warnings: string[]
}

function makeCors(origin?: string) {
  const allowOrigin = origin && origin !== '' ? origin : '*'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  }
}

const json = (status: number, body: unknown, origin?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...makeCors(origin) },
  })

// Claude が返す tool_use.input の型 (extract_registry ツール定義と一致させる)
const TOOL_SCHEMA = {
  name: 'extract_registry',
  description:
    '日本の不動産登記 PDF から現在有効な (下線=抹消 されていない) 権利者情報を抽出する',
  input_schema: {
    type: 'object',
    properties: {
      location: {
        type: ['string', 'null'],
        description:
          '所在 (例: 「斜里郡斜里町港町」)。都道府県は省略。ない場合は null',
      },
      parcel_number: {
        type: ['string', 'null'],
        description:
          '地番。半角ハイフン形式に正規化 (例: 「1-22」「269-1」)。単一地番なら「269」のみ。',
      },
      land_category: {
        type: ['string', 'null'],
        description:
          '現在の地目 (例: 「田」「宅地」「雑種地」)。分筆等で複数変化がある場合は最新のもの。',
      },
      area_sqm: {
        type: ['number', 'null'],
        description:
          '現在の地積 (㎡)。小数以下 2 桁まで許容。分筆等で複数変化がある場合は最新のもの。',
      },
      owners: {
        type: 'array',
        description:
          '現在の所有者一覧。甲区の最新の所有権登記で有効な権利者のみ (下線=抹消 されているものは除外)。共有なら複数。',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                '氏名。全角スペース区切りは詰める (「元　木　祐　二」→「元木祐二」)。',
            },
            address: {
              type: 'string',
              description: '住所。全角スペースは詰める。',
            },
            share: {
              type: ['string', 'null'],
              description:
                '持分 (例: 「1/2」「持分3分の1」→「1/3」)。単有なら null。',
            },
          },
          required: ['name', 'address'],
        },
      },
      confidence: {
        type: 'number',
        description:
          '0.0-1.0 の抽出信頼度。PDF が壊れていたり読み取り困難な場合は低い値を返す。',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description:
          '抽出時に注意した点があれば列挙 (例: 「相続登記が2件連続していたため最後のものを採用」)。',
      },
    },
    required: ['location', 'parcel_number', 'owners', 'confidence', 'warnings'],
  },
}

function buildPrompt(kind: 'ownership' | 'full', hint?: ParseBody['hint']): string {
  const hintParts: string[] = []
  if (hint?.location) hintParts.push(`所在ヒント: ${hint.location}`)
  if (hint?.parcel_number) hintParts.push(`地番ヒント: ${hint.parcel_number}`)
  if (hint?.file_name) hintParts.push(`ファイル名: ${hint.file_name}`)
  const hintText = hintParts.length
    ? `\n\n参考情報 (これらと矛盾する場合は PDF の記載を優先):\n${hintParts.join('\n')}`
    : ''

  const kindText =
    kind === 'ownership'
      ? '添付 PDF は「所有者事項」証明書 (¥140 の簡易版) です。所有者一覧のみ含まれ、地目・地積の情報はありません (area_sqm, land_category は null で返す)。'
      : '添付 PDF は「全部事項証明書」(¥334 の詳細版) です。表題部 (所在・地番・地目・地積) と 甲区 (所有者履歴) が含まれます。分筆・合筆・相続・売買等で複数の履歴がある場合、下線=抹消 されているものを除外し、現在有効な最新のものを採用してください。'

  return `${kindText}

extract_registry ツールで、現在有効な登記情報を抽出してください。${hintText}

重要:
- 下線 (=抹消) された情報は除外する
- 共有登記の場合、owners に全員を含める (share も設定)
- 会社所有の場合、name に法人格を含めた正式名称 (例: 「株式会社元木金物店」)
- 氏名や住所の全角スペースは詰める`
}

async function callClaude(
  apiKey: string,
  pdfBase64: string,
  kind: 'ownership' | 'full',
  hint?: ParseBody['hint'],
): Promise<Extracted> {
  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'extract_registry' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: buildPrompt(kind, hint),
          },
        ],
      },
    ],
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '(no body)')
    throw new Error(`anthropic_api_error: status=${res.status} body=${errBody.slice(0, 500)}`)
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
    stop_reason?: string
  }

  const toolBlock = data.content?.find(
    (c) => c.type === 'tool_use' && c.name === 'extract_registry',
  )
  if (!toolBlock || !toolBlock.input) {
    throw new Error(
      `no_tool_use_in_response: stop_reason=${data.stop_reason} content=${JSON.stringify(data.content).slice(0, 300)}`,
    )
  }

  const raw = toolBlock.input as Record<string, unknown>
  return normalizeExtracted(raw)
}

/** Claude が返した object を厳しめに型付けして返す (欠損時は null/空配列で埋める) */
function normalizeExtracted(raw: Record<string, unknown>): Extracted {
  const owners: ExtractedOwner[] = []
  if (Array.isArray(raw.owners)) {
    for (const o of raw.owners) {
      if (!o || typeof o !== 'object') continue
      const oo = o as Record<string, unknown>
      const name = typeof oo.name === 'string' ? oo.name.trim() : null
      const address = typeof oo.address === 'string' ? oo.address.trim() : null
      if (!name || !address) continue
      owners.push({
        name,
        address,
        share:
          typeof oo.share === 'string' && oo.share.trim().length > 0
            ? oo.share.trim()
            : null,
      })
    }
  }
  const warnings: string[] = []
  if (Array.isArray(raw.warnings)) {
    for (const w of raw.warnings) {
      if (typeof w === 'string') warnings.push(w)
    }
  }
  return {
    location: typeof raw.location === 'string' ? raw.location.trim() : null,
    parcel_number:
      typeof raw.parcel_number === 'string' ? raw.parcel_number.trim() : null,
    land_category:
      typeof raw.land_category === 'string' ? raw.land_category.trim() : null,
    area_sqm:
      typeof raw.area_sqm === 'number' && Number.isFinite(raw.area_sqm)
        ? raw.area_sqm
        : null,
    owners,
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0,
    warnings,
  }
}

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
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json(
      500,
      { ok: false, error: 'Server not configured (supabase)' },
      origin,
    )
  }
  if (!anthropicKey) {
    return json(
      500,
      {
        ok: false,
        error:
          'Server not configured (ANTHROPIC_API_KEY). supabase secrets set ANTHROPIC_API_KEY=... を実行してください。',
      },
      origin,
    )
  }

  // --- 認証 ---
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(
    callerToken,
  )
  if (callerErr || !callerData.user) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }

  // Phase 1: サイトオーナー限定
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  })
  const { data: siteOwner, error: soErr } = await asCaller.rpc('is_site_owner')
  if (soErr) {
    return json(
      500,
      { ok: false, error: 'Site owner check failed: ' + soErr.message },
      origin,
    )
  }
  if (siteOwner !== true) {
    return json(
      403,
      { ok: false, error: 'Not authorized (site owner only)' },
      origin,
    )
  }

  // --- body 検証 ---
  let body: ParseBody
  try {
    body = (await req.json()) as ParseBody
  } catch {
    return json(400, { ok: false, error: 'Bad Request' }, origin)
  }
  const kind = body.kind
  if (kind !== 'ownership' && kind !== 'full') {
    return json(400, { ok: false, error: 'kind must be ownership or full' }, origin)
  }
  const pdfBase64 = body.pdf_base64
  if (typeof pdfBase64 !== 'string' || pdfBase64.length === 0) {
    return json(400, { ok: false, error: 'pdf_base64 required' }, origin)
  }
  // base64 は decoded で最大 5MB まで許容 (登記 PDF は通常 30〜200 KB)
  const approxSize = Math.floor(pdfBase64.length * 0.75)
  if (approxSize > 5 * 1024 * 1024) {
    return json(400, { ok: false, error: 'pdf too large (>5MB)' }, origin)
  }

  // --- Claude 呼び出し ---
  try {
    const extracted = await callClaude(anthropicKey, pdfBase64, kind, body.hint)
    return json(200, { ok: true, extracted }, origin)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json(
      500,
      { ok: false, error: msg },
      origin,
    )
  }
})
