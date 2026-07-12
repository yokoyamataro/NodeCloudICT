#!/usr/bin/env node
// G 空間情報センターの CKAN から法務省地図データ (登記所備付地図) を取得し、
// Supabase Storage + parcel_map_datasets に投入する CLI。
//
// フロー (各リソースごと):
//   1. CKAN から package/resource 一覧を取得 (scout と同じ)
//   2. 同じ (registry_code, registry_sub) の DB レコードを検索
//      → 既存の source_year >= 新しい year なら SKIP
//   3. ZIP を DL
//   4. 中身から .geojson を抽出
//   5. normalizeGovParcelGeoJson 相当の処理を実行 (properties 正規化 + bbox 計算)
//   6. 正規化 GeoJSON を Supabase Storage に upload
//   7. parcel_map_datasets を upsert
//
// 環境変数:
//   SUPABASE_URL                 例: https://xxxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    Admin キー (Storage / DB 全操作可)
//
// 依存:
//   adm-zip                      npm install adm-zip --save-dev で追加
//   @supabase/supabase-js        (プロダクション依存として既存)
//   proj4                        (プロダクション依存として既存)
//
// 使い方:
//   node scripts/sync-parcel-maps.mjs --prefecture 01     北海道だけ
//   node scripts/sync-parcel-maps.mjs --prefecture 01,13  北海道 + 東京
//   node scripts/sync-parcel-maps.mjs                     全国 (要覚悟)
//   node scripts/sync-parcel-maps.mjs --dry-run           DL・upload せず件数だけ集計
//   node scripts/sync-parcel-maps.mjs --limit 10          先頭 10 件だけ
//   node scripts/sync-parcel-maps.mjs --concurrency 5     並列度 (デフォルト 3)
//   node scripts/sync-parcel-maps.mjs --active            投入時に active=true に

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { config as loadEnv } from 'node:process' // (Node 22+ 用フォールバックなし)

// ---- 動的 import (依存が入っているかチェック) ----
let createSupabaseClient
let proj4
let streamJsonParser
let streamJsonPick
let streamJsonArray
let streamChain

try {
  createSupabaseClient = (await import('@supabase/supabase-js')).createClient
} catch {
  console.error('[sync] @supabase/supabase-js がありません (通常はあるはず)')
  process.exit(1)
}
try {
  proj4 = (await import('proj4')).default
} catch {
  console.error('[sync] proj4 がありません (通常はあるはず)')
  process.exit(1)
}
// stream-json: 巨大 GeoJSON (V8 の string 上限 ~512MB を超える) をストリーミング
// パースするため。無ければ従来の buf.toString('utf8') 経路にフォールバック。
try {
  // stream-json v3 では parser() / pick() / streamArray() は「transformer 関数」を
  // 返し、そのまま Node.js Stream にはならない。stream-chain の chain() で
  // 合成すると 1 本の Duplex stream になり、pipe / async iteration が使える。
  streamJsonParser = (await import('stream-json')).parser
  streamJsonPick = (await import('stream-json/filters/pick.js')).pick
  streamJsonArray = (await import('stream-json/streamers/stream-array.js')).streamArray
  streamChain = (await import('stream-chain')).chain
  if (!streamJsonParser || !streamJsonPick || !streamJsonArray || !streamChain) {
    throw new Error('stream-json exports missing')
  }
} catch (err) {
  streamJsonParser = null
  console.warn(
    '[sync] stream-json をロードできません。巨大 GeoJSON は失敗します:',
    err?.message ?? err,
  )
}

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- .env をゆるく読む (SUPABASE_URL 等を拾う) ----
const _loadedFromEnv = []
function loadDotEnv() {
  const path = resolve(__dirname, '..', '.env')
  try {
    let text = readFileSync(path, 'utf8')
    // BOM 除去
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const k = trimmed.slice(0, eq).trim()
      let v = trimmed.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!process.env[k]) process.env[k] = v
      _loadedFromEnv.push({ key: k, valueLen: v.length })
    }
  } catch (err) {
    console.warn('[sync] .env の読み込みに失敗:', err.message ?? err)
  }
}
loadDotEnv()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[sync] 環境変数が不足しています:')
  console.error('  SUPABASE_URL:              ' + (SUPABASE_URL ? 'set' : 'MISSING'))
  console.error('  SUPABASE_SERVICE_ROLE_KEY: ' + (SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING'))
  console.error('')
  console.error('.env から読み込まれたキー一覧:')
  if (_loadedFromEnv.length === 0) {
    console.error('  (何も読み込まれていません — .env が空 or パスが違う可能性)')
  } else {
    for (const { key, valueLen } of _loadedFromEnv) {
      console.error(`  ${key} (length=${valueLen})`)
    }
  }
  console.error('')
  console.error('ヒント:')
  console.error('  - キー名は完全一致で "SUPABASE_SERVICE_ROLE_KEY" (大文字、末尾は _KEY)')
  console.error('  - "=" の前後にスペースは入れない (SUPABASE_SERVICE_ROLE_KEY=eyJ...)')
  console.error('  - 値は 200 文字以上の JWT (eyJ... で始まる)')
  process.exit(1)
}

// ---- args ----
function parseArgs(argv) {
  const args = {
    base: 'https://www.geospatial.jp/ckan',
    org: 'aigid-moj-map', // 「法務省登記所備付地図データ変換済」org
    prefectures: null, // Set<string> or null (全県)
    concurrency: 3,
    limit: 0, // 0 = 全部
    dryRun: false,
    active: false,
    bucket: 'parcel-maps',
    page: 100,
    gzip: true, // GeoJSON を gzip 圧縮して upload (Storage 50MB 上限回避)
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') args.base = argv[++i]
    else if (a === '--org') args.org = argv[++i]
    else if (a === '--prefecture') {
      args.prefectures = new Set(
        argv[++i]
          .split(',')
          .map((s) => s.trim().padStart(2, '0'))
          .filter(Boolean),
      )
    } else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10)
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10)
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--active') args.active = true
    else if (a === '--bucket') args.bucket = argv[++i]
    else if (a === '--page') args.page = parseInt(argv[++i], 10)
    else if (a === '--no-gzip') args.gzip = false
    else if (a === '--gzip') args.gzip = true
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/sync-parcel-maps.mjs [options]

Options:
  --base <url>          CKAN base URL (default: https://www.geospatial.jp/ckan)
  --query <str>         Search keyword (default: 登記所備付地図)
  --prefecture <codes>  対象都道府県コード カンマ区切り (例: 01,13)
  --concurrency <n>     並列 DL 数 (default: 3)
  --limit <n>           先頭 n 件だけ処理 (default: 0=全部)
  --dry-run             DB / Storage に書き込まず件数集計だけ
  --active              投入する dataset を active=true に (通常は false)
  --bucket <name>       Storage bucket (default: parcel-maps)
  --no-gzip             GeoJSON を gzip 圧縮せずに upload (default: 圧縮する)
  --help, -h            このヘルプ
`)
      process.exit(0)
    }
  }
  return args
}
const args = parseArgs(process.argv)

// ---- CKAN client ----
async function ckanSearchByOrg(base, org, start, rows) {
  const url = new URL(
    `${base.replace(/\/+$/, '')}/api/3/action/package_search`,
  )
  url.searchParams.set('fq', `organization:${org}`)
  url.searchParams.set('rows', String(rows))
  url.searchParams.set('start', String(start))
  const res = await fetch(url, { headers: { 'User-Agent': 'nodecloud-sync/1.0' } })
  if (!res.ok) throw new Error(`CKAN search failed: ${res.status} ${res.statusText}`)
  const json = await res.json()
  if (!json.success) throw new Error(`CKAN error: ${JSON.stringify(json.error)}`)
  return json.result
}

// ---- filename parsing ----
// aigid-moj-map の GeoJSON リソース名は
//   "06201_山形市_公共座標10系_筆R_2025.geojson" のような形式。
// name / title から municipality_code, zone, year を抽出。
const RESOURCE_NAME_RE = /^(\d{5})_(.+?)_公共座標(\d+)系_筆R_(\d{4})\.geojson$/

function parseResourceName(name) {
  if (!name) return null
  const m = name.match(RESOURCE_NAME_RE)
  if (!m) return null
  return {
    municipality_code: m[1],
    municipality_name: m[2],
    zone: parseInt(m[3], 10),
    year: parseInt(m[4], 10),
  }
}

function prefectureCode(code) {
  const p = code.slice(0, 2)
  const n = parseInt(p, 10)
  if (n >= 1 && n <= 47) return p.padStart(2, '0')
  return null
}

// ---- proj4 setup (JGD2011 平面直角座標系 各系原点) ----
const JGD2011_ORIGINS = {
  1: [129.5, 33.0],
  2: [131.0, 33.0],
  3: [132.166666667, 36.0],
  4: [133.5, 33.0],
  5: [134.333333333, 36.0],
  6: [136.0, 36.0],
  7: [137.166666667, 36.0],
  8: [138.5, 36.0],
  9: [139.833333333, 36.0],
  10: [140.833333333, 40.0],
  11: [140.25, 44.0],
  12: [142.25, 44.0],
  13: [144.25, 44.0],
  14: [142.0, 26.0],
  15: [127.5, 26.0],
  16: [124.0, 26.0],
  17: [131.0, 26.0],
  18: [136.0, 20.0],
  19: [154.0, 26.0],
}

function jgd2011ProjDef(zone) {
  const [lon0, lat0] = JGD2011_ORIGINS[zone]
  return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`
}
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'

// ---- 座標系抽出 ("公共座標13系" → 13) ----
function extractZone(csText) {
  if (typeof csText !== 'string') return null
  const m = csText.match(/(\d{1,2})\s*系/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return n >= 1 && n <= 19 ? n : null
}

// ---- GeoJSON 正規化 (client 側 normalizeGovParcelGeoJson の Node 版) ----
function normalizeGovParcelGeoJson(raw, filenameHintZone) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.type !== 'FeatureCollection' ||
    !Array.isArray(raw.features)
  ) {
    throw new Error('GeoJSON の形式が正しくありません')
  }
  const acc = createNormalizeAccumulator(filenameHintZone)
  for (const f of raw.features) acc.push(f)
  return acc.finalize()
}

/** ストリーミング / 一括両方から使える正規化アキュムレータ。
 *  push(feature) を Feature ごとに呼ぶ → 最後に finalize() で結果を得る。
 *  これで巨大 GeoJSON でも buf.toString('utf8') せず処理できる。 */
function createNormalizeAccumulator(filenameHintZone) {
  const features = []
  let detectedZone = null
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity

  return {
    push(f) {
      if (!f || f.type !== 'Feature') return
      if (!f.geometry || f.geometry.type !== 'Polygon') return
      const coords = f.geometry.coordinates
      if (!Array.isArray(coords) || coords.length === 0) return

      const props = f.properties ?? {}
      const chiban = String(props['地番'] ?? '').trim()
      const ooaza = String(props['大字名'] ?? '').trim()
      const chome = String(props['丁目名'] ?? '').trim()
      const idFallback = String(props['ID'] ?? '').trim()
      const parcel_number = chiban || idFallback
      const locationParts = [ooaza, chome].filter((s) => s.length > 0)
      const location = locationParts.length > 0 ? locationParts.join(' ') : null
      const parcel_name = location
        ? `${location} ${chiban}`.trim()
        : chiban || parcel_number

      const zoneHere = extractZone(props['座標系']) ?? filenameHintZone ?? 0
      if (detectedZone == null && zoneHere > 0) detectedZone = zoneHere

      const outer = coords[0]
      for (const p of outer) {
        const lng = p[0],
          lat = p[1]
        if (lng < minLng) minLng = lng
        if (lat < minLat) minLat = lat
        if (lng > maxLng) maxLng = lng
        if (lat > maxLat) maxLat = lat
      }

      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          parcel_number,
          parcel_name,
          location,
          owner_name: null,
          registered_area_sqm: null,
          jprc_coords: [],
          source_zone: zoneHere ?? 0,
        },
      })
    },
    finalize() {
      const bbox = Number.isFinite(minLng)
        ? { minLng, minLat, maxLng, maxLat }
        : null
      return {
        featureCollection: { type: 'FeatureCollection', features },
        bbox,
        parcelCount: features.length,
        detectedZone,
      }
    },
  }
}

// ---- 大 Buffer をチャンクとして流すためのジェネレータ (stream-json のトークナイザ用) ----
function* chunkBuffer(buf, size = 4 * 1024 * 1024) {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, i + size)
  }
}

/** 巨大 GeoJSON (V8 の string 上限 ~512MB 超) を Buffer.toString せずに正規化する。
 *  stream-json でトップの features 配列を stream し、Feature ごとに accumulator へ push。 */
async function normalizeStreaming(buf, filenameHintZone) {
  if (!streamJsonParser || !streamChain) {
    throw new Error(
      'stream-json が入っていないので巨大 GeoJSON は処理できません: npm i -D stream-json',
    )
  }
  const acc = createNormalizeAccumulator(filenameHintZone)
  // chain([...]) は 複数の transformer 関数と Readable を 1 本の Duplex stream に合成する
  const pipeline = streamChain([
    Readable.from(chunkBuffer(buf)),
    streamJsonParser(),
    streamJsonPick({ filter: 'features' }),
    streamJsonArray(),
  ])
  // StreamArray の出力は { key, value } オブジェクト。value が Feature 本体。
  for await (const chunk of pipeline) {
    acc.push(chunk.value)
  }
  return acc.finalize()
}

// ---- リトライ付き fetch (大きい GeoJSON の DL が途中で切れる対策) ----
// ストリーミング DL で進捗を表示、途中で 60 秒無音になったらタイムアウト再試行。
async function fetchWithRetry(url, { retries = 4, stallMs = 60_000, onProgress } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ac = new AbortController()
      let lastByteAt = Date.now()
      // 一定時間データが来なかったら abort する watchdog
      const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > stallMs) {
          ac.abort(new Error(`no data for ${Math.round(stallMs / 1000)}s`))
        }
      }, 5000)
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'nodecloud-sync/1.0' },
          signal: ac.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const total = Number(res.headers.get('content-length')) || 0
        const chunks = []
        let received = 0
        const reader = res.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.byteLength
          lastByteAt = Date.now()
          onProgress?.(received, total)
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c)))
      } finally {
        clearInterval(watchdog)
      }
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        const wait = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 1000
        console.log(
          `[sync]   retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)}s (${err.message ?? err})`,
        )
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

// ---- 並列制御 ----
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = []
  for (let w = 0; w < concurrency; w++) {
    runners.push(
      (async () => {
        while (true) {
          const i = next++
          if (i >= items.length) return
          try {
            results[i] = await worker(items[i], i)
          } catch (err) {
            results[i] = { error: err.message ?? String(err) }
          }
        }
      })(),
    )
  }
  await Promise.all(runners)
  return results
}

// ---- 1 リソース処理 ----
async function processResource(supabase, item, prefixLog) {
  const { url, filename, parsed, package_title, package_id, resource_id, size } = item
  const registry_code = parsed.municipality_code
  const registry_sub = '' // GeoJSON 直配布は sub 無し。UNIQUE 制約用に空文字列で埋める
  const source_year = parsed.year
  const prefecture_code = prefectureCode(registry_code)

  // 既存 DB を検索
  const { data: existing, error: selErr } = await supabase
    .from('parcel_map_datasets')
    .select('id, source_year, storage_geojson_path')
    .eq('registry_code', registry_code)
    .eq('registry_sub', registry_sub)
    .maybeSingle()
  if (selErr && selErr.code !== 'PGRST116') throw selErr

  if (existing && existing.source_year >= source_year) {
    return {
      status: 'skip',
      reason: `already have year ${existing.source_year} (new: ${source_year})`,
    }
  }

  if (args.dryRun) {
    return { status: 'would-process', size: size ?? null }
  }

  // GeoJSON を DL (aigid-moj-map からは直接 GeoJSON なので ZIP 展開不要)
  // 大きい GeoJSON (鶴岡市クラス) だと接続が切れることがあるので retry する
  prefixLog('downloading GeoJSON...')
  let buf
  let lastLogAt = 0
  try {
    buf = await fetchWithRetry(url, {
      retries: 4,
      stallMs: 60_000,
      onProgress: (received, total) => {
        const now = Date.now()
        if (now - lastLogAt < 5000) return
        lastLogAt = now
        const mb = (received / 1024 / 1024).toFixed(1)
        const pct = total > 0 ? ` (${Math.round((received / total) * 100)}%)` : ''
        console.log(`[sync]   ${item.filename}: ${mb} MB${pct}`)
      },
    })
  } catch (e) {
    return { status: 'error', reason: `DL failed after retries: ${e.message ?? e}` }
  }
  // V8 の string 上限 (0x1fffffe8 ≈ 536MB) を安全マージンで超えるものは
  // 最初からストリーミングパースに回す。それ以下でも一度失敗したらフォールバック。
  const SAFE_STRING_MAX = 400 * 1024 * 1024
  let norm
  try {
    if (buf.byteLength > SAFE_STRING_MAX) {
      prefixLog(`streaming parse (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)...`)
      norm = await normalizeStreaming(buf, undefined)
    } else {
      let raw
      try {
        raw = JSON.parse(buf.toString('utf8'))
      } catch (e) {
        if (
          streamJsonParser &&
          typeof e?.message === 'string' &&
          e.message.includes('Cannot create a string longer than')
        ) {
          prefixLog('streaming parse fallback (string length overflow)...')
          norm = await normalizeStreaming(buf, undefined)
        } else {
          return { status: 'error', reason: 'invalid JSON: ' + e.message }
        }
      }
      if (norm === undefined) {
        if (raw?.type !== 'FeatureCollection' || !Array.isArray(raw?.features)) {
          return {
            status: 'error',
            reason: `not a FeatureCollection (type=${raw?.type ?? 'null'})`,
          }
        }
        prefixLog('normalizing...')
        norm = normalizeGovParcelGeoJson(raw)
      }
    }
  } catch (e) {
    return { status: 'error', reason: 'parse failed: ' + (e?.message ?? e) }
  }
  const effectiveZone = norm.detectedZone ?? 0
  for (const f of norm.featureCollection.features) {
    if (f.properties.source_zone === 0) f.properties.source_zone = effectiveZone
  }

  // dataset id
  const datasetId = existing?.id ?? crypto.randomUUID()
  const rawJson = Buffer.from(JSON.stringify(norm.featureCollection), 'utf8')
  const useGzip = args.gzip
  const geoJsonPath = useGzip
    ? `${datasetId}/parcels.geojson.gz`
    : `${datasetId}/parcels.geojson`
  const uploadBlob = useGzip ? gzipSync(rawJson, { level: 9 }) : rawJson
  const contentType = useGzip ? 'application/gzip' : 'application/geo+json'

  // 旧 storage を削除 (更新時 / 圧縮方式が変わった時)
  if (existing?.storage_geojson_path && existing.storage_geojson_path !== geoJsonPath) {
    await supabase.storage.from(args.bucket).remove([existing.storage_geojson_path]).catch(() => {})
  }

  // Storage upload
  prefixLog(
    `uploading to storage (${useGzip ? `gzip ${uploadBlob.byteLength}B / raw ${rawJson.byteLength}B` : `${uploadBlob.byteLength}B`})...`,
  )
  const uploadRes = await supabase.storage.from(args.bucket).upload(geoJsonPath, uploadBlob, {
    contentType,
    upsert: true,
  })
  if (uploadRes.error) throw new Error(`storage upload failed: ${uploadRes.error.message}`)

  // DB upsert
  prefixLog('upserting DB row...')
  // 例: "山形県-山形市" or "06201 山形市 (R2025)"
  const displayName =
    package_title ||
    `${registry_code} ${parsed.municipality_name ?? ''} (${source_year})`.trim()
  const upsertBody = {
    id: datasetId,
    name: displayName,
    description: `G空間情報センターより自動同期 (${new Date().toISOString().slice(0, 10)})`,
    coordinate_zone: effectiveZone || 13,
    source_kind: 'geojson',
    storage_xml_path: null,
    storage_geojson_path: geoJsonPath,
    tile_format: 'geojson',
    bbox: norm.bbox,
    parcel_count: norm.parcelCount,
    active: args.active,
    registry_code,
    registry_sub,
    prefecture_code,
    source_year,
    source_url: url,
    ckan_package_id: package_id,
    ckan_resource_id: resource_id,
    bbox_min_lng: norm.bbox?.minLng ?? null,
    bbox_min_lat: norm.bbox?.minLat ?? null,
    bbox_max_lng: norm.bbox?.maxLng ?? null,
    bbox_max_lat: norm.bbox?.maxLat ?? null,
  }
  const { error: upsertErr } = await supabase
    .from('parcel_map_datasets')
    .upsert(upsertBody, { onConflict: 'registry_code,registry_sub' })
  if (upsertErr) throw upsertErr

  return {
    status: existing ? 'updated' : 'created',
    parcelCount: norm.parcelCount,
    size: uploadBlob.byteLength,
    rawSize: rawJson.byteLength,
  }
}

// ---- main ----
async function main() {
  console.log(`[sync] Base URL:      ${args.base}`)
  console.log(`[sync] Organization:  ${args.org}`)
  console.log(`[sync] Prefectures:   ${args.prefectures ? [...args.prefectures].join(',') : 'ALL'}`)
  console.log(`[sync] Concurrency:   ${args.concurrency}`)
  console.log(`[sync] Limit:         ${args.limit || 'no limit'}`)
  console.log(`[sync] Dry-run:       ${args.dryRun}`)
  console.log(`[sync] Set active:    ${args.active}`)
  console.log(`[sync] Bucket:        ${args.bucket}`)
  console.log(`[sync] gzip upload:   ${args.gzip}`)

  // 1. org 内の全 package を集める
  let allPackages = []
  let start = 0
  while (true) {
    const result = await ckanSearchByOrg(args.base, args.org, start, args.page)
    allPackages = allPackages.concat(result.results)
    console.log(`[sync] Fetched packages ${start} - ${start + result.results.length} / ${result.count}`)
    if (allPackages.length >= result.count || result.results.length === 0) break
    start += args.page
  }
  console.log(`[sync] Total packages in org: ${allPackages.length}`)

  // 2. 各 package から .geojson のリソースだけ拾って parseResourceName
  const items = []
  let unparsedCount = 0
  for (const pkg of allPackages) {
    for (const r of pkg.resources ?? []) {
      const fmt = String(r.format ?? '').toLowerCase()
      if (fmt !== 'geojson') continue // shp.zip はスキップ
      const parsed = parseResourceName(r.name)
      if (!parsed) {
        unparsedCount++
        continue
      }
      items.push({
        package_id: pkg.id,
        package_title: pkg.title,
        resource_id: r.id,
        url: r.url,
        filename: r.name,
        size: r.size ?? null,
        parsed,
      })
    }
  }
  console.log(
    `[sync] GeoJSON resources: ${items.length} (unparsed name: ${unparsedCount})`,
  )

  // 3. municipality_code 単位で最新年度のみ残す
  const latestPerMun = new Map()
  for (const it of items) {
    const key = it.parsed.municipality_code
    const cur = latestPerMun.get(key)
    if (!cur || cur.parsed.year < it.parsed.year) latestPerMun.set(key, it)
  }
  let latest = [...latestPerMun.values()]

  // 4. 都道府県フィルタ
  if (args.prefectures) {
    latest = latest.filter((it) =>
      args.prefectures.has(prefectureCode(it.parsed.municipality_code) ?? ''),
    )
  }
  // 5. 上限
  if (args.limit > 0) latest = latest.slice(0, args.limit)

  console.log(`[sync] Targets: ${latest.length} municipalities`)
  if (latest.length === 0) {
    console.log('[sync] Nothing to do.')
    return
  }

  const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const startedAt = Date.now()
  let done = 0
  const stats = { created: 0, updated: 0, skip: 0, error: 0, 'would-process': 0 }
  const errors = []

  await runWithConcurrency(latest, args.concurrency, async (item) => {
    const prefixLog = (msg) => {
      // 何もしない (詳細ログは verbose 化時にオンに)
    }
    try {
      const result = await processResource(supabase, item, prefixLog)
      stats[result.status] = (stats[result.status] ?? 0) + 1
      done++
      const eta =
        latest.length > done
          ? Math.round(((Date.now() - startedAt) / done) * (latest.length - done) / 1000)
          : 0
      console.log(
        `[sync] [${done}/${latest.length}] ${result.status.padEnd(15)} ${item.filename} ${result.reason ?? result.parcelCount ?? ''} (ETA ${eta}s)`,
      )
    } catch (err) {
      stats.error++
      done++
      errors.push({ file: item.filename, error: err.message ?? String(err) })
      console.error(`[sync] [${done}/${latest.length}] ERROR ${item.filename}: ${err.message ?? err}`)
    }
  })

  const totalSec = Math.round((Date.now() - startedAt) / 1000)
  console.log('\n============================================================')
  console.log('  Sync summary')
  console.log('============================================================')
  console.log(`  Targets:       ${latest.length}`)
  console.log(`  Created:       ${stats.created}`)
  console.log(`  Updated:       ${stats.updated}`)
  console.log(`  Skipped:       ${stats.skip}`)
  console.log(`  Would-process: ${stats['would-process']}`)
  console.log(`  Errors:        ${stats.error}`)
  console.log(`  Total time:    ${totalSec}s`)
  if (errors.length > 0) {
    console.log('\nFirst 10 errors:')
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${e.file}: ${e.error}`)
    }
  }
}

main().catch((err) => {
  console.error('[sync] Fatal:', err)
  process.exit(1)
})

void loadEnv // 変数抑止
