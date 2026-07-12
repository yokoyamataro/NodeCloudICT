#!/usr/bin/env node
// G空間情報センター (CKAN ベース) の「登記所備付地図データ」全国配布状況を偵察するスクリプト。
// 実際の DL や Storage 書き込みはしない。件数・URL・サイズ推定・年度分布だけ集めて JSON 出力する。
//
// 目的:
//   * DB スキーマ変更 / 本番同期パイプラインを組む前に、全国で
//     何ファイル / どの位のサイズ / どの年度が配布されているかを実測する。
//
// 使い方:
//   node scripts/scout-parcel-maps.mjs
//   node scripts/scout-parcel-maps.mjs --base https://front.geospatial.jp
//   node scripts/scout-parcel-maps.mjs --query "登記所備付地図"
//   node scripts/scout-parcel-maps.mjs --output doc/parcel-map-inventory.json
//
// CKAN API の base URL は環境によって違う場合があるので --base で切替可。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- args ----
function parseArgs(argv) {
  const args = {
    base: null, // 明示指定が無ければ CANDIDATE_BASES を順に試す
    query: '登記所備付地図',
    output: 'doc/parcel-map-inventory.json',
    page: 100,
    diagnose: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') args.base = argv[++i]
    else if (a === '--query') args.query = argv[++i]
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--page') args.page = parseInt(argv[++i], 10)
    else if (a === '--diagnose') args.diagnose = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  console.log(`Usage: node scripts/scout-parcel-maps.mjs [options]

Options:
  --base <url>       CKAN base URL (未指定なら候補を順に試す)
  --query <string>   Search keyword (default: 登記所備付地図)
  --output <path>    Output JSON path (default: doc/parcel-map-inventory.json)
  --page <n>         CKAN page size (default: 100)
  --diagnose         接続テストのみ実行して終了
  --help, -h         Show this help
`)
}

const args = parseArgs(process.argv)

// G空間情報センターの CKAN 想定 base URL 候補。ヒットする最初の 1 つを採用する。
const CANDIDATE_BASES = [
  'https://www.geospatial.jp/ckan',
  'https://www.geospatial.jp/gp_front',
  'https://front.geospatial.jp',
  'https://front.geospatial.jp/ckan',
  'https://data.geospatial.jp',
  'https://data.geospatial.jp/ckan',
  'https://www.geospatial.jp',
]

// 「法務省登記所備付地図データ変換済」組織のスラッグ候補。
// CKAN の slug はローマ字化されることが多い。ヒットするものを順に試す。
const CANDIDATE_ORG_SLUGS = [
  '法務省登記所備付地図データ変換済',
  'houmusho-tokishobibitsuke-chizu-data-henkanzumi',
  'moj-tokishobibitsuke-chizu-data-henkanzumi',
  'moj-tokishomotsuke-chizu',
  'moj-registered-map',
]

// ---- URL helpers ----
function joinUrl(base, path) {
  // base の subpath を捨てずに path を連結する
  const b = base.replace(/\/+$/, '')
  const p = path.replace(/^\/+/, '')
  return `${b}/${p}`
}

// ---- CKAN client ----
async function ckanFetch(base, action, params) {
  const url = new URL(joinUrl(base, `api/3/action/${action}`))
  for (const [k, v] of Object.entries(params ?? {})) {
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'nodecloud-scout/1.0' },
  })
  if (!res.ok) {
    throw new Error(
      `CKAN ${action} failed: ${res.status} ${res.statusText}\n  URL: ${url}`,
    )
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    const preview = (await res.text()).slice(0, 200)
    throw new Error(
      `CKAN ${action} returned non-JSON (probably wrong base URL).\n  URL: ${url}\n  Content-Type: ${contentType}\n  Body preview: ${preview}`,
    )
  }
  const json = await res.json()
  if (!json.success) {
    throw new Error(`CKAN returned error: ${JSON.stringify(json.error)}`)
  }
  return json.result
}

async function ckanSearch(base, query, start, rows) {
  return ckanFetch(base, 'package_search', { q: query, rows, start })
}

async function ckanPing(base) {
  // 接続テスト。status_show は最軽量のエンドポイント
  try {
    await ckanFetch(base, 'status_show', {})
    return true
  } catch (err) {
    return { error: err.message ?? String(err) }
  }
}

async function resolveBase() {
  if (args.base) {
    console.log(`[scout] Using --base ${args.base}`)
    return args.base
  }
  console.log('[scout] --base 未指定。候補を順にプローブ:')
  for (const b of CANDIDATE_BASES) {
    process.stdout.write(`  ${b} ... `)
    const result = await ckanPing(b)
    if (result === true) {
      console.log('OK')
      return b
    } else {
      console.log(`NG (${result.error.split('\n')[0]})`)
    }
  }
  throw new Error(
    'CKAN base URL が見つかりません。--base で明示指定してください。',
  )
}

// ---- filename parsing ----
// CKAN の ZIP ファイル名パターン (例: "16343-2301-2024.zip")
//   {code5}-{sub4}-{year4}
// 補助的に旧 GeoJSON 名 (例: "01545_斜里郡斜里町_公共座標13系_筆R_2025.geojson") も救う。
const FILENAME_RE_ZIP = /^(\d{5})-(\d{4})-(\d{4})/
const FILENAME_RE_GEO = /(\d{5})[_-]+(?:[^_]*[_-])*(?:r|R|reiwa|令和)?[_-]*(\d{4})/i

function parseFilename(name) {
  const zip = name.match(FILENAME_RE_ZIP)
  if (zip) {
    return {
      code: zip[1],
      sub: zip[2],
      year: parseInt(zip[3], 10),
    }
  }
  const geo = name.match(FILENAME_RE_GEO)
  if (geo) {
    return {
      code: geo[1],
      sub: null,
      year: parseInt(geo[2], 10),
    }
  }
  return null
}

// 5 桁 コードの先頭 2 桁が都道府県コード (01-47) と一致すれば prefecture として扱う
function prefectureCodeFromFileCode(code) {
  const p = code.slice(0, 2)
  const n = parseInt(p, 10)
  if (n >= 1 && n <= 47) return p.padStart(2, '0')
  return null
}

// 追加: package.title から都道府県 - 市町村名 を抜き出す試み
// 例: "北海道-斜里郡斜里町" → { prefecture: '北海道', municipality: '斜里郡斜里町' }
function parsePackageTitle(title) {
  if (!title) return null
  const m = title.match(/^([^\s\-]+?[都道府県])[\s\-]+(.+)$/)
  if (!m) return null
  return { prefecture: m[1], municipality: m[2].trim() }
}

const PREFECTURE_NAMES = {
  '01': '北海道',
  '02': '青森県',
  '03': '岩手県',
  '04': '宮城県',
  '05': '秋田県',
  '06': '山形県',
  '07': '福島県',
  '08': '茨城県',
  '09': '栃木県',
  10: '群馬県',
  11: '埼玉県',
  12: '千葉県',
  13: '東京都',
  14: '神奈川県',
  15: '新潟県',
  16: '富山県',
  17: '石川県',
  18: '福井県',
  19: '山梨県',
  20: '長野県',
  21: '岐阜県',
  22: '静岡県',
  23: '愛知県',
  24: '三重県',
  25: '滋賀県',
  26: '京都府',
  27: '大阪府',
  28: '兵庫県',
  29: '奈良県',
  30: '和歌山県',
  31: '鳥取県',
  32: '島根県',
  33: '岡山県',
  34: '広島県',
  35: '山口県',
  36: '徳島県',
  37: '香川県',
  38: '愛媛県',
  39: '高知県',
  40: '福岡県',
  41: '佐賀県',
  42: '長崎県',
  43: '熊本県',
  44: '大分県',
  45: '宮崎県',
  46: '鹿児島県',
  47: '沖縄県',
}

function prefName(code) {
  return PREFECTURE_NAMES[String(code)] || PREFECTURE_NAMES[Number(code)] || `(${code})`
}

function formatBytes(bytes) {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

// ---- Main ----
async function main() {
  const base = await resolveBase()
  console.log(`[scout] Base URL: ${base}`)
  console.log(`[scout] Query:    "${args.query}"`)
  console.log(`[scout] Page:     ${args.page}`)

  if (args.diagnose) {
    console.log('[scout] --diagnose 指定のため接続テストのみで終了')
    return
  }

  // 1. CKAN search で全 package を取得
  let allPackages = []
  let start = 0
  while (true) {
    const result = await ckanSearch(base, args.query, start, args.page)
    const gotThisPage = result.results.length
    allPackages = allPackages.concat(result.results)
    console.log(
      `[scout] Fetched packages ${start} - ${start + gotThisPage} / ${result.count}`,
    )
    if (allPackages.length >= result.count || gotThisPage === 0) break
    start += args.page
  }
  console.log(`[scout] Total packages retrieved: ${allPackages.length}`)

  // --- 全 resources を列挙して統計 (フォーマット判定の実測用) ---
  const allResources = []
  const formatDist = {}
  for (const pkg of allPackages) {
    for (const r of pkg.resources ?? []) {
      const url = r.url ?? ''
      const filename = url.split('/').pop()?.split('?')[0] ?? ''
      const fmt = String(r.format ?? '').toLowerCase() || '(empty)'
      formatDist[fmt] = (formatDist[fmt] || 0) + 1
      allResources.push({
        package_id: pkg.id,
        package_name: pkg.name,
        package_title: pkg.title,
        resource_id: r.id,
        resource_name: r.name,
        url,
        size: r.size ?? null,
        format: r.format,
        mimetype: r.mimetype,
        last_modified: r.last_modified ?? r.metadata_modified ?? null,
        filename,
      })
    }
  }
  console.log(`[scout] Total resources (any format): ${allResources.length}`)
  console.log('[scout] Format distribution:')
  for (const [fmt, count] of Object.entries(formatDist).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${fmt.padEnd(20)}: ${count}`)
  }
  if (allResources.length > 0) {
    console.log('[scout] First 5 resource samples:')
    for (const r of allResources.slice(0, 5)) {
      console.log(
        `  format=${JSON.stringify(r.format)} mimetype=${JSON.stringify(r.mimetype)} filename="${r.filename}"`,
      )
      console.log(`    url: ${r.url}`)
    }
  }

  // 2. 実データを持つリソースだけ抽出。G 空間 CKAN は ZIP 配布が主流。
  //    もし将来 GeoJSON 単体で配られた場合も拾えるようにしておく。
  const resources = []
  for (const r of allResources) {
    const fmt = String(r.format ?? '').toLowerCase()
    const isDataFile =
      fmt === 'zip' ||
      fmt === 'geojson' ||
      /\.(geo)?json(\?|$|#)/i.test(r.url) ||
      /\.zip(\?|$|#)/i.test(r.url) ||
      /\.(geo)?json$/i.test(r.filename) ||
      /\.zip$/i.test(r.filename) ||
      /geo\+?json/i.test(r.mimetype ?? '')
    if (!isDataFile) continue
    resources.push({ ...r, parsed: parseFilename(r.filename), file_kind: fmt })
  }
  console.log(`[scout] Data resources (ZIP or GeoJSON): ${resources.length}`)

  const parsedResources = resources.filter((r) => r.parsed)
  const unparsedResources = resources.filter((r) => !r.parsed)

  // 3. Aggregate stats
  const perPrefecture = {}
  const perYear = {}
  // 「同じ code + sub」の組み合わせ = 同じデータの別年度。code+sub 単位で最新年度を残す
  const groupKey = (p) => `${p.code}|${p.sub ?? ''}`
  const perGroupLatestYear = {}
  let totalSize = 0
  let sizeUnknownCount = 0

  // 追加: package title から都道府県を推定
  const packageTitleByKey = {}
  for (const r of resources) {
    packageTitleByKey[r.package_id] = r.package_title
  }

  for (const r of parsedResources) {
    // 都道府県判定: file code の先頭 2 桁 → 有効な都道府県コードならそれを採用
    // それも駄目なら package title から抽出
    const p =
      prefectureCodeFromFileCode(r.parsed.code) ??
      (() => {
        const parsed = parsePackageTitle(r.package_title)
        if (!parsed) return '--'
        for (const [c, n] of Object.entries(PREFECTURE_NAMES)) {
          if (n === parsed.prefecture) return String(c).padStart(2, '0')
        }
        return '--'
      })()
    perPrefecture[p] = (perPrefecture[p] || 0) + 1
    perYear[r.parsed.year] = (perYear[r.parsed.year] || 0) + 1

    const gk = groupKey(r.parsed)
    const existing = perGroupLatestYear[gk]
    if (!existing || existing < r.parsed.year) {
      perGroupLatestYear[gk] = r.parsed.year
    }

    if (r.size != null) totalSize += Number(r.size)
    else sizeUnknownCount++
  }

  const latestOnly = parsedResources.filter(
    (r) => r.parsed.year === perGroupLatestYear[groupKey(r.parsed)],
  )
  let latestTotalSize = 0
  let latestSizeUnknownCount = 0
  for (const r of latestOnly) {
    if (r.size != null) latestTotalSize += Number(r.size)
    else latestSizeUnknownCount++
  }
  const uniqueGroups = Object.keys(perGroupLatestYear).length

  // 4. Print summary
  console.log('\n============================================================')
  console.log('  法務省地図データ 全国配布状況 (偵察結果)')
  console.log('============================================================')
  console.log(`Packages retrieved:               ${allPackages.length}`)
  console.log(`GeoJSON resources total:          ${resources.length}`)
  console.log(`  ├ Filename parsed:              ${parsedResources.length}`)
  console.log(`  └ Filename unparsed:            ${unparsedResources.length}`)
  console.log('')
  console.log(`Unique groups (code+sub):         ${uniqueGroups}`)
  console.log(`Latest-only DL target:            ${latestOnly.length} files`)
  console.log('')
  console.log(`Reported size (all years):        ${formatBytes(totalSize)} (unknown: ${sizeUnknownCount})`)
  console.log(`Reported size (latest year only): ${formatBytes(latestTotalSize)} (unknown: ${latestSizeUnknownCount})`)
  console.log('')
  console.log('Prefecture distribution:')
  const prefEntries = Object.entries(perPrefecture).sort((a, b) => b[1] - a[1])
  for (const [code, count] of prefEntries) {
    console.log(`  ${String(code).padStart(2, '0')} ${prefName(code).padEnd(6)}: ${count}`)
  }
  console.log('')
  console.log('Year distribution:')
  for (const [year, count] of Object.entries(perYear).sort()) {
    console.log(`  ${year}: ${count}`)
  }

  if (unparsedResources.length > 0) {
    console.log('')
    console.log(`Unparsed filename samples (first 10 of ${unparsedResources.length}):`)
    for (const r of unparsedResources.slice(0, 10)) {
      console.log(`  ${r.filename}`)
    }
  }

  // 5. Write detailed inventory to JSON
  const outputPath = resolve(__dirname, '..', args.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        scoutedAt: new Date().toISOString(),
        base,
        query: args.query,
        totals: {
          packages: allPackages.length,
          resources: resources.length,
          parsed: parsedResources.length,
          unparsed: unparsedResources.length,
          uniqueGroups,
          latestOnlyDlTarget: latestOnly.length,
          latestOnlyReportedSize: latestTotalSize,
          latestOnlyReportedSizeUnknown: latestSizeUnknownCount,
        },
        formatDistribution: formatDist,
        allResourcesSample: allResources.slice(0, 30),
        perPrefecture,
        perYear,
        resources: latestOnly.map((r) => ({
          code: r.parsed.code,
          sub: r.parsed.sub,
          year: r.parsed.year,
          prefecture: prefectureCodeFromFileCode(r.parsed.code),
          package_title: r.package_title,
          url: r.url,
          size: r.size,
          format: r.format,
          last_modified: r.last_modified,
          package_id: r.package_id,
          resource_id: r.resource_id,
          filename: r.filename,
        })),
        unparsedSamples: unparsedResources.slice(0, 30),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\n[scout] Detailed inventory written to: ${outputPath}`)
  console.log('[scout] Done.')
}

main().catch((err) => {
  console.error('\n[scout] Failed:', err.message ?? err)
  console.error('\n[scout] Tips:')
  console.error('  - まず接続テストだけ: node scripts/scout-parcel-maps.mjs --diagnose')
  console.error('  - ブラウザで開ける URL を控えて --base で指定してください')
  console.error('    例) https://www.geospatial.jp/ の右上検索欄で「登記所備付地図」を検索し、')
  console.error('        カタログのトップページ URL をコピー。CKAN の一般構造: <base>/api/3/action/...')
  console.error('  - --query "地図" で広めに叩いて命中する package を探す手もあり')
  process.exit(1)
})
