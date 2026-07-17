// サイトオーナー限定: 登記情報提供サービス (touki.or.jp) の PDF を自動取得する
// Edge Function。実際の Playwright 操作は Fly.io の registry-fetcher 上で走らせ、
// ここはその「Vault 資格情報の読み出し + Fly.io へのプロキシ + PDF 保管」に徹する。
//
// フロー:
//   1. 呼び出し元 JWT を検証し、is_site_owner() で権限を確認 (Phase 1 制限)
//   2. get_registry_credentials() で touki.or.jp の ID/PW を復号
//   3. 入力 (work_area_id + prefecture / city / location / parcel_number) を per-parcel に検証
//   4. Fly.io app へ (X-Auth-Token 付き) で POST。全 parcel を serial で処理してもらう
//   5. 各 result の pdfBase64 を storage.attachments bucket に upload
//      パス: {project_id}/work_area/{work_area_id}/registry_{kind}_{timestamp}.pdf
//   6. attachments テーブルへ INSERT (entity_type='work_area', category='registry_{kind}')
//   7. 失敗した parcel は per-item error として返却 (残りは成功として残す)
//
// 必要な環境変数 (Supabase secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (auto)
//   FLY_REGISTRY_URL     ex: https://nodecloud-registry-fetcher.fly.dev
//   FLY_REGISTRY_SECRET  ex: <40 桁ランダム、Fly.io app の X_AUTH_TOKEN と同値>
//
// デプロイ: supabase functions deploy fetch-registry-pdfs

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ParcelReqItem {
  work_area_id: string
  prefecture: string
  city: string
  location: string
  parcel_number: string
}

interface FetchBody {
  requests?: ParcelReqItem[]
  kind?: 'ownership' | 'full'
}

interface FlyResult {
  id: string
  kind: 'ownership' | 'full'
  pdfBase64: string | null
  error: string | null
}

interface EdgeResult {
  work_area_id: string
  parcel_number: string
  kind: 'ownership' | 'full'
  attachment_id: string | null
  signed_url: string | null
  error: string | null
}

const STORAGE_BUCKET = 'attachments'
const SIGNED_URL_TTL_SEC = 60 * 30 // 30 min

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

function isValidItem(x: unknown): x is ParcelReqItem {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.work_area_id === 'string' &&
    typeof o.prefecture === 'string' &&
    typeof o.city === 'string' &&
    typeof o.location === 'string' &&
    typeof o.parcel_number === 'string' &&
    o.parcel_number.length > 0
  )
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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
  const flyUrl = Deno.env.get('FLY_REGISTRY_URL') ?? ''
  const flySecret = Deno.env.get('FLY_REGISTRY_SECRET') ?? ''
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json(500, { ok: false, error: 'Server not configured (supabase)' }, origin)
  }
  if (!flyUrl || !flySecret) {
    return json(500, { ok: false, error: 'Server not configured (fly.io)' }, origin)
  }

  // --- 1. 認証 ---
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerToken = authHeader.replace(/^Bearer\s+/i, '')
  if (!callerToken) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken)
  if (callerErr || !callerData.user) {
    return json(401, { ok: false, error: 'Not authenticated' }, origin)
  }
  const callerId = callerData.user.id

  // Phase 1: サイトオーナー限定
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  })
  const { data: siteOwner, error: soErr } = await asCaller.rpc('is_site_owner')
  if (soErr) {
    return json(500, { ok: false, error: 'Site owner check failed: ' + soErr.message }, origin)
  }
  if (siteOwner !== true) {
    return json(403, { ok: false, error: 'Not authorized (site owner only)' }, origin)
  }

  // --- 2. body 検証 ---
  let body: FetchBody
  try {
    body = (await req.json()) as FetchBody
  } catch {
    return json(400, { ok: false, error: 'Bad Request' }, origin)
  }
  const kind = body.kind
  if (kind !== 'ownership' && kind !== 'full') {
    return json(400, { ok: false, error: 'kind must be ownership or full' }, origin)
  }
  const requests = Array.isArray(body.requests) ? body.requests : []
  if (requests.length === 0) {
    return json(400, { ok: false, error: 'requests must be a non-empty array' }, origin)
  }
  if (requests.length > 50) {
    return json(400, { ok: false, error: 'requests too many (max 50)' }, origin)
  }
  for (const r of requests) {
    if (!isValidItem(r)) {
      return json(400, { ok: false, error: 'invalid request item shape' }, origin)
    }
  }

  // --- 3. 資格情報の読み出し (service_role で RPC 経由) ---
  //     get_registry_credentials は SECURITY DEFINER + auth.uid() チェックのため、
  //     呼び出し元 JWT を持つ anon client で叩く必要がある。
  const { data: credData, error: credErr } = await asCaller.rpc(
    'get_registry_credentials',
  )
  if (credErr) {
    return json(500, { ok: false, error: 'Failed to load credentials: ' + credErr.message }, origin)
  }
  const cred = Array.isArray(credData) ? credData[0] : credData
  if (!cred || typeof cred !== 'object') {
    return json(400, { ok: false, error: '登記情報の認証情報が未登録です (設定 → 登記情報)' }, origin)
  }
  const username = (cred as { username?: string }).username
  const password = (cred as { password?: string }).password
  if (!username || !password) {
    return json(400, { ok: false, error: '登記情報の認証情報が空です' }, origin)
  }

  // --- 4. work_area_id → project_id / parcel_id / farm_id の解決 ---
  //     service_role で直接引く (RLS bypass)。work_area_id が存在しない場合は
  //     per-parcel エラーに落とす。
  const workAreaIds = Array.from(new Set(requests.map((r) => r.work_area_id)))
  const { data: waRows, error: waErr } = await admin
    .from('design_work_areas')
    .select('id, farm_id, farms:farm_id(project_id)')
    .in('id', workAreaIds)
  if (waErr) {
    return json(500, { ok: false, error: 'work_area lookup failed: ' + waErr.message }, origin)
  }
  const projectByWorkAreaId = new Map<string, string>()
  for (const row of (waRows ?? []) as Array<{
    id: string
    farms: { project_id: string } | { project_id: string }[] | null
  }>) {
    const farms = Array.isArray(row.farms) ? row.farms[0] : row.farms
    if (farms?.project_id) projectByWorkAreaId.set(row.id, farms.project_id)
  }

  // --- 5. Fly.io app へ丸投げ ---
  const flyPayload = {
    username,
    password,
    requests: requests.map((r) => ({
      id: r.work_area_id,
      prefecture: r.prefecture,
      city: r.city,
      location: r.location,
      parcel_number: r.parcel_number,
      kind,
    })),
  }
  let flyResults: FlyResult[]
  try {
    const flyRes = await fetch(`${flyUrl}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': flySecret,
      },
      body: JSON.stringify(flyPayload),
    })
    if (!flyRes.ok) {
      const text = await flyRes.text().catch(() => '')
      return json(502, {
        ok: false,
        error: `Fly.io service returned ${flyRes.status}: ${text.slice(0, 500)}`,
      }, origin)
    }
    const parsed = (await flyRes.json()) as { results?: FlyResult[] }
    flyResults = Array.isArray(parsed.results) ? parsed.results : []
  } catch (err) {
    return json(502, {
      ok: false,
      error: 'Fly.io service unreachable: ' + (err instanceof Error ? err.message : String(err)),
    }, origin)
  }

  // --- 6. per-parcel: Storage 保存 + attachments INSERT ---
  const now = new Date().toISOString().replace(/[:.]/g, '-')
  const out: EdgeResult[] = []
  for (const fly of flyResults) {
    const src = requests.find((r) => r.work_area_id === fly.id)
    const projectId = projectByWorkAreaId.get(fly.id)
    if (!src || !projectId) {
      out.push({
        work_area_id: fly.id,
        parcel_number: src?.parcel_number ?? '',
        kind,
        attachment_id: null,
        signed_url: null,
        error: 'work_area not found or project unresolvable',
      })
      continue
    }
    if (fly.error || !fly.pdfBase64) {
      out.push({
        work_area_id: fly.id,
        parcel_number: src.parcel_number,
        kind,
        attachment_id: null,
        signed_url: null,
        error: fly.error ?? 'no pdf returned',
      })
      continue
    }

    const bytes = base64ToBytes(fly.pdfBase64)
    const filePath =
      `${projectId}/work_area/${fly.id}/registry_${kind}_${now}.pdf`
    const { error: upErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, bytes, {
        contentType: 'application/pdf',
        upsert: false,
      })
    if (upErr) {
      out.push({
        work_area_id: fly.id,
        parcel_number: src.parcel_number,
        kind,
        attachment_id: null,
        signed_url: null,
        error: 'storage upload failed: ' + upErr.message,
      })
      continue
    }

    const category =
      kind === 'ownership' ? 'registry_ownership' : 'registry_full'
    const { data: att, error: attErr } = await admin
      .from('attachments')
      .insert({
        project_id: projectId,
        entity_type: 'work_area',
        entity_id: fly.id,
        file_path: filePath,
        mime: 'application/pdf',
        byte_size: bytes.byteLength,
        category,
        caption: `${src.location} ${src.parcel_number}`,
        created_by: callerId,
      })
      .select('id')
      .single()
    if (attErr || !att) {
      out.push({
        work_area_id: fly.id,
        parcel_number: src.parcel_number,
        kind,
        attachment_id: null,
        signed_url: null,
        error: 'attachments insert failed: ' + (attErr?.message ?? 'unknown'),
      })
      continue
    }

    const { data: signed, error: signErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(filePath, SIGNED_URL_TTL_SEC)
    if (signErr) {
      // Signed URL 失敗は致命ではない (attachments 経由でクライアント再取得可)
      out.push({
        work_area_id: fly.id,
        parcel_number: src.parcel_number,
        kind,
        attachment_id: att.id,
        signed_url: null,
        error: null,
      })
      continue
    }

    out.push({
      work_area_id: fly.id,
      parcel_number: src.parcel_number,
      kind,
      attachment_id: att.id,
      signed_url: signed?.signedUrl ?? null,
      error: null,
    })
  }

  return json(200, { ok: true, results: out }, origin)
})
