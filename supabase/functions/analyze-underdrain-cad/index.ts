// サイトオーナー / プロジェクト編集者限定: 暗渠 CAD (DXF) の pipe run と
// 情報テキスト (未マッチ分) を Claude Sonnet 4.6 に投げて、
// 「pipe run ごとの管径 + 長さ」を構造化 JSON で返してもらう。
//
// フロント側で regex パース + ニアレストネイバー暫定対応付けを済ませ、
// 「AI 補正が必要 (needsAi=true)」な pipe run だけをここに送る想定。
// ただし小規模図面 (~20 run 以下) なら全部投げても OK。
//
// 必要な環境変数 (Supabase secrets, 登記 PDF と共有):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto)
//   ANTHROPIC_API_KEY
//
// デプロイ: supabase functions deploy analyze-underdrain-cad

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192

interface PipeRunInput {
  /** クライアント側で振った ID (例: 'P1', 'P42') */
  id: string
  /** 折れ線頂点 (DXF 座標系、単位 mm) */
  vertices: Array<{ x: number; y: number }>
  /** 座標長さ (mm) */
  length_mm: number
  /** 事前パースで決まった管径 (mm) — null なら AI で推定 */
  tentative_diameter_mm: number | null
  /** 事前パースで決まった長さ (m) と由来 */
  tentative_length_m: number | null
  tentative_length_source: 'label' | 'computed' | null
}

interface InfoLabelInput {
  /** ラベル位置 (DXF 座標系) */
  x: number
  y: number
  /** 生テキスト */
  content: string
  /** クライアント側で regex 抽出できた値 (ヒント) */
  diameter_mm: number | null
  length_m: number | null
}

interface CircleInput {
  /** 管径変更点 CIRCLE の中心 */
  cx: number
  cy: number
  radius: number
}

interface AnalyzeBody {
  project_id?: string
  farm_id?: string | null
  pipe_runs?: PipeRunInput[]
  info_labels?: InfoLabelInput[]
  /** 管径変更点 (CIRCLE) の位置 — AI が pipe run の境界を理解するのに使う */
  diameter_change_circles?: CircleInput[]
  /** 画像 (base64 PNG)。必ずしも必須ではないが、あると精度が上がる */
  image_base64?: string | null
}

interface ExtractedPipe {
  pipe_id: string
  diameter_mm: number | null
  length_m: number | null
  length_source: 'label' | 'computed'
  confidence: number
  warnings: string[]
}

interface Extracted {
  pipes: ExtractedPipe[]
  unmatched_pipe_ids: string[]
  unmatched_labels: Array<{ content: string; x: number; y: number }>
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

// tool 定義: Claude に extract_pipes(input) を強制的に呼ばせる
const TOOL_SCHEMA = {
  name: 'extract_pipes',
  description:
    '暗渠 CAD の pipe run 一覧と情報ラベル位置から、各 pipe run の管径 (mm) と長さ (m) を確定する',
  input_schema: {
    type: 'object',
    properties: {
      pipes: {
        type: 'array',
        description: '各 pipe run の推定結果',
        items: {
          type: 'object',
          properties: {
            pipe_id: {
              type: 'string',
              description: '入力 pipe_runs[].id と同一の識別子',
            },
            diameter_mm: {
              type: ['integer', 'null'],
              description: '管径 (mm)。判定できなければ null',
            },
            length_m: {
              type: ['number', 'null'],
              description:
                '長さ (m)。ラベル記載があれば優先、無ければ座標由来 (length_mm/1000)',
            },
            length_source: {
              type: 'string',
              enum: ['label', 'computed'],
              description: 'label = ラベルから読み取り, computed = 座標から算出',
            },
            confidence: {
              type: 'number',
              description: '0.0〜1.0 の信頼度',
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['pipe_id', 'diameter_mm', 'length_m', 'length_source', 'confidence', 'warnings'],
        },
      },
      unmatched_pipe_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '管径 / 長さのどちらも決められなかった pipe_id',
      },
      unmatched_labels: {
        type: 'array',
        description: '対応する pipe run が見つからなかった情報ラベル',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['content', 'x', 'y'],
        },
      },
      confidence: { type: 'number' },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['pipes', 'unmatched_pipe_ids', 'unmatched_labels', 'confidence', 'warnings'],
  },
}

function buildPrompt(body: AnalyzeBody): string {
  const runsSummary = body.pipe_runs?.length ?? 0
  const labelsSummary = body.info_labels?.length ?? 0
  return `暗渠 (地下排水管) CAD 図面から抽出した pipe run と、情報ラベル (φNNN L=NN 等) の位置から、
各 pipe run に対応する管径 (mm) と長さ (m) を確定してください。

前提:
- 座標系は DXF そのまま (mm 単位, X=東, Y=北 相当)。緯度経度ではありません。
- pipe run は既に連続する LINE をつなげた折れ線です。管径変更点 (CIRCLE) で
  切断済み — 1 run = 1 管径のはず。
- 情報ラベルは「φ100 L=14」「φ150 L=132」「φ60」「L=6」「1」「2」等の TEXT。
  数字だけのラベルは管番号なので抽出対象外。
- 各 label に一番近い pipe run が対応候補。ただし CAD によっては引出線があり、
  ラベル位置が管から少し離れる場合あり。

タスク:
1. tentative_diameter_mm / tentative_length_m が既に入っている pipe run は
   基本的にそのまま採用。ただし明らかに不整合なら AI で修正 (warnings に理由)。
2. tentative_diameter_mm が null の pipe run について、近傍の label から
   管径を推定。
3. length は label 記載を優先、無ければ length_mm/1000 を採用 (length_source を
   正しく設定)。
4. 対応付けできない pipe / label は unmatched に。

入力サマリ:
- pipe_runs: ${runsSummary} 本
- info_labels: ${labelsSummary} 個
- diameter_change_circles: ${body.diameter_change_circles?.length ?? 0} 個 (=pipe run の境界)

extract_pipes ツールを必ず 1 回だけ呼び出して結果を返してください。`
}

async function callClaude(apiKey: string, body: AnalyzeBody): Promise<Extracted> {
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: buildPrompt(body),
    },
    {
      type: 'text',
      text:
        '===== pipe_runs (JSON) =====\n' +
        JSON.stringify(body.pipe_runs ?? [], null, 0) +
        '\n===== info_labels (JSON) =====\n' +
        JSON.stringify(body.info_labels ?? [], null, 0) +
        '\n===== diameter_change_circles (JSON) =====\n' +
        JSON.stringify(body.diameter_change_circles ?? [], null, 0),
    },
  ]
  if (body.image_base64) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: body.image_base64,
      },
    })
  }

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'extract_pipes' },
    messages: [{ role: 'user', content: userContent }],
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
    throw new Error(
      `anthropic_api_error: status=${res.status} body=${errBody.slice(0, 500)}`,
    )
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
    stop_reason?: string
  }
  const toolBlock = data.content?.find(
    (c) => c.type === 'tool_use' && c.name === 'extract_pipes',
  )
  if (!toolBlock || !toolBlock.input) {
    throw new Error(
      `no_tool_use_in_response: stop_reason=${data.stop_reason} content=${JSON.stringify(data.content).slice(0, 300)}`,
    )
  }
  return normalize(toolBlock.input as Record<string, unknown>)
}

function normalize(raw: Record<string, unknown>): Extracted {
  const pipes: ExtractedPipe[] = []
  if (Array.isArray(raw.pipes)) {
    for (const p of raw.pipes) {
      if (!p || typeof p !== 'object') continue
      const pp = p as Record<string, unknown>
      const pipe_id = typeof pp.pipe_id === 'string' ? pp.pipe_id : ''
      if (!pipe_id) continue
      pipes.push({
        pipe_id,
        diameter_mm:
          typeof pp.diameter_mm === 'number' && Number.isFinite(pp.diameter_mm)
            ? Math.round(pp.diameter_mm)
            : null,
        length_m:
          typeof pp.length_m === 'number' && Number.isFinite(pp.length_m)
            ? pp.length_m
            : null,
        length_source: pp.length_source === 'label' ? 'label' : 'computed',
        confidence:
          typeof pp.confidence === 'number' && Number.isFinite(pp.confidence)
            ? Math.max(0, Math.min(1, pp.confidence))
            : 0,
        warnings: Array.isArray(pp.warnings)
          ? pp.warnings.filter((w): w is string => typeof w === 'string')
          : [],
      })
    }
  }
  const unmatched_pipe_ids: string[] = Array.isArray(raw.unmatched_pipe_ids)
    ? (raw.unmatched_pipe_ids.filter((s): s is string => typeof s === 'string'))
    : []
  const unmatched_labels: Extracted['unmatched_labels'] = Array.isArray(
    raw.unmatched_labels,
  )
    ? raw.unmatched_labels
        .map((l): { content: string; x: number; y: number } | null => {
          if (!l || typeof l !== 'object') return null
          const ll = l as Record<string, unknown>
          const content = typeof ll.content === 'string' ? ll.content : null
          const x = typeof ll.x === 'number' ? ll.x : null
          const y = typeof ll.y === 'number' ? ll.y : null
          if (content == null || x == null || y == null) return null
          return { content, x, y }
        })
        .filter((v): v is { content: string; x: number; y: number } => v != null)
    : []
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0
  const warnings: string[] = Array.isArray(raw.warnings)
    ? raw.warnings.filter((s): s is string => typeof s === 'string')
    : []
  return { pipes, unmatched_pipe_ids, unmatched_labels, confidence, warnings }
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
    return json(500, { ok: false, error: 'Server not configured (supabase)' }, origin)
  }
  if (!anthropicKey) {
    return json(500, { ok: false, error: 'Server not configured (ANTHROPIC_API_KEY)' }, origin)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) return json(401, { ok: false, error: 'Not authenticated' }, origin)

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData.user) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }

  // 権限チェック: project_editor or site_owner
  let body: AnalyzeBody
  try {
    body = (await req.json()) as AnalyzeBody
  } catch {
    return json(400, { ok: false, error: 'Bad Request' }, origin)
  }
  if (!body.project_id || typeof body.project_id !== 'string') {
    return json(400, { ok: false, error: 'project_id required' }, origin)
  }
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  })
  const { data: canEdit, error: editErr } = await asCaller.rpc('is_project_editor', {
    p_project_id: body.project_id,
  } as never)
  if (editErr) {
    return json(500, { ok: false, error: 'Permission check failed: ' + editErr.message }, origin)
  }
  if (canEdit !== true) {
    return json(403, { ok: false, error: 'Not authorized (project editor required)' }, origin)
  }

  if (!Array.isArray(body.pipe_runs) || body.pipe_runs.length === 0) {
    return json(400, { ok: false, error: 'pipe_runs required' }, origin)
  }
  if (body.pipe_runs.length > 300) {
    return json(400, { ok: false, error: 'pipe_runs too many (max 300)' }, origin)
  }

  try {
    const extracted = await callClaude(anthropicKey, body)
    return json(200, { ok: true, extracted }, origin)
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) }, origin)
  }
})
