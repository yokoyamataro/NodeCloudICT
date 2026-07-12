#!/usr/bin/env node
// G 空間情報センターの CKAN から「登記所備付地図」に関連する組織を列挙し、
// 各組織が配布するリソース形式 (ZIP / GeoJSON / XML) の分布を出す。
//
// 目的: 直接 GeoJSON を配布している組織があればそちらを使いたい。
//       (ZIP の中に XML が入る形式は 1 パッケージ 1.8GB 級で全国では TB クラスになる)
//
// 使い方:
//   node scripts/list-parcel-orgs.mjs
//   node scripts/list-parcel-orgs.mjs --keyword "変換済"

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = {
    base: 'https://www.geospatial.jp/ckan',
    keyword: '登記所備付地図',
    org: null, // 特定の org name を指定
    packageId: null, // 特定の package を調べる
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') args.base = argv[++i]
    else if (a === '--keyword') args.keyword = argv[++i]
    else if (a === '--org') args.org = argv[++i]
    else if (a === '--package') args.packageId = argv[++i]
  }
  return args
}
const args = parseArgs(process.argv)

async function ckanCall(base, action, params) {
  const url = new URL(`${base.replace(/\/+$/, '')}/api/3/action/${action}`)
  for (const [k, v] of Object.entries(params ?? {})) {
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'nodecloud-scout/1.0' },
  })
  if (!res.ok) throw new Error(`${action} failed: ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error(`${action} error: ${JSON.stringify(json.error)}`)
  return json.result
}

async function main() {
  console.log(`[list-orgs] Base: ${args.base}`)

  // package が指定されていたら package_show 経由で org を特定
  if (args.packageId) {
    console.log(`[list-orgs] --package "${args.packageId}" の情報を取得`)
    const pkg = await ckanCall(args.base, 'package_show', { id: args.packageId })
    console.log(`  title      : ${pkg.title}`)
    console.log(`  name       : ${pkg.name}`)
    console.log(`  organization:`)
    console.log(`    name     : ${pkg.organization?.name}`)
    console.log(`    title    : ${pkg.organization?.title}`)
    console.log(`    id       : ${pkg.organization?.id}`)
    console.log(`  resources  :`)
    for (const r of pkg.resources ?? []) {
      console.log(
        `    - ${r.name || '(no name)'} [${r.format}] ${r.url}`,
      )
    }
    return
  }

  // 1. 全 organization を取得 (CKAN の pagination に対応)
  const orgs = []
  const PAGE = 200
  let offset = 0
  while (true) {
    const batch = await ckanCall(args.base, 'organization_list', {
      all_fields: true,
      include_extras: false,
      limit: PAGE,
      offset,
    })
    orgs.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
  }
  console.log(`[list-orgs] Total organizations: ${orgs.length}`)

  // 2. 対象 org を絞る
  let matched
  if (args.org) {
    console.log(`[list-orgs] Filter: --org "${args.org}"`)
    matched = orgs.filter((o) => o.name === args.org)
  } else {
    console.log(`[list-orgs] Keyword: "${args.keyword}"`)
    matched = orgs.filter((o) => {
      return (
        (o.title ?? '').includes(args.keyword) ||
        (o.display_name ?? '').includes(args.keyword) ||
        (o.name ?? '').includes(args.keyword) ||
        (o.description ?? '').includes(args.keyword)
      )
    })
  }
  console.log(`[list-orgs] Matched organizations: ${matched.length}`)

  for (const o of matched) {
    console.log(`\n  ─ name        : ${o.name}`)
    console.log(`    title       : ${o.title}`)
    console.log(`    display_name: ${o.display_name}`)
    console.log(`    packages    : ${o.package_count ?? '?'}`)

    // 3. その org の package を 1 件だけ取ってリソース形式を確認
    try {
      const search = await ckanCall(args.base, 'package_search', {
        fq: `organization:${o.name}`,
        rows: 3,
      })
      console.log(`    matched packages (sampled 3):`)
      for (const p of search.results) {
        const formats = (p.resources ?? []).map((r) => r.format).join('/')
        console.log(`      · "${p.title}" — resources: [${formats}]`)
      }
      // 全形式集計 (最大 500 件で頭出し)
      const fullSearch = await ckanCall(args.base, 'package_search', {
        fq: `organization:${o.name}`,
        rows: 500,
      })
      const fmts = {}
      for (const p of fullSearch.results) {
        for (const r of p.resources ?? []) {
          const f = String(r.format ?? '(none)').toLowerCase()
          fmts[f] = (fmts[f] || 0) + 1
        }
      }
      console.log(`    format distribution (first 500 pkgs):`)
      for (const [f, c] of Object.entries(fmts).sort((a, b) => b[1] - a[1])) {
        console.log(`      ${f.padEnd(15)}: ${c}`)
      }
    } catch (err) {
      console.log(`    (failed to search: ${err.message ?? err})`)
    }
  }

  if (matched.length === 0 && !args.org) {
    console.log(`[list-orgs] No org matched keyword "${args.keyword}".`)
    console.log(`[list-orgs] All orgs (name — title):`)
    for (const o of orgs) {
      console.log(`  ${o.name} — ${o.title}`)
    }
  }
}

main().catch((err) => {
  console.error('[list-orgs] Failed:', err.message ?? err)
  process.exit(1)
})
