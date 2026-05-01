#!/usr/bin/env node
// ISG（International Service for the Geoid）形式のジオイドモデルを
// コンパクトなバイナリに変換する。
//
// 入力:  doc/JPGEO2024+Hrefconv2024.isg  （N-to-S, W-to-E のテキストグリッド）
// 出力:  public/geoid/jp_geoid_2024.bin   （独自バイナリ）
//
// バイナリフォーマット (little-endian):
//   [0..4)   magic = "JGRD"  (4 bytes)
//   [4..8)   version = 1     (uint32)
//   [8..16)  latMin           (float64, deg)
//   [16..24) latMax           (float64, deg)
//   [24..32) lonMin           (float64, deg)
//   [32..40) lonMax           (float64, deg)
//   [40..48) dLat             (float64, deg/cell)
//   [48..56) dLon             (float64, deg/cell)
//   [56..60) nrows            (uint32)
//   [60..64) ncols            (uint32)
//   [64..)   data             (nrows*ncols * float32, N-to-S, W-to-E。nodata は NaN)
//
// 既定でクロップ範囲 lat 20-46, lon 122-150 に縮小（日本全土をカバー、約 5MB）。
//
// 使い方:
//   node scripts/convert-geoid-isg.mjs
//   node scripts/convert-geoid-isg.mjs --input ./doc/foo.isg --output ./public/geoid/bar.bin
//   node scripts/convert-geoid-isg.mjs --bbox 30,46,128,148

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

function parseArgs(argv) {
  const out = {
    input: resolve(repoRoot, 'doc', 'JPGEO2024+Hrefconv2024.isg'),
    output: resolve(repoRoot, 'NodeCloudICT', 'public', 'geoid', 'jp_geoid_2024.bin'),
    bbox: [20, 46, 122, 150], // [latMin, latMax, lonMin, lonMax]
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--input') out.input = resolve(argv[++i])
    else if (a === '--output') out.output = resolve(argv[++i])
    else if (a === '--bbox') {
      const parts = argv[++i].split(',').map(Number)
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) out.bbox = parts
      else throw new Error('--bbox は latMin,latMax,lonMin,lonMax で指定')
    }
  }
  return out
}

// dms 表記 ("15°00'00\"") を度に変換
function dmsToDeg(text) {
  const m = String(text).trim().match(/^(-?\d+)\s*°\s*(\d+)\s*'\s*(\d+(?:\.\d+)?)"?$/)
  if (!m) throw new Error(`不正な dms 表記: ${text}`)
  const sign = m[1].startsWith('-') ? -1 : 1
  const deg = Math.abs(parseInt(m[1], 10))
  const min = parseInt(m[2], 10)
  const sec = parseFloat(m[3])
  return sign * (deg + min / 60 + sec / 3600)
}

function parseHeader(lines) {
  const map = new Map()
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('end_of_head')) {
      i++
      break
    }
    const idx = line.indexOf(':')
    const eq = line.indexOf('=')
    const sep = idx >= 0 && (eq < 0 || idx < eq) ? idx : eq
    if (sep < 0) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    const val = line.slice(sep + 1).trim()
    map.set(key, val)
  }
  const need = ['lat min', 'lat max', 'lon min', 'lon max', 'delta lat', 'delta lon', 'nrows', 'ncols', 'nodata']
  for (const k of need) if (!map.has(k)) throw new Error(`ヘッダ欠落: ${k}`)
  return {
    latMin: dmsToDeg(map.get('lat min')),
    latMax: dmsToDeg(map.get('lat max')),
    lonMin: dmsToDeg(map.get('lon min')),
    lonMax: dmsToDeg(map.get('lon max')),
    dLat: dmsToDeg(map.get('delta lat')),
    dLon: dmsToDeg(map.get('delta lon')),
    nrows: parseInt(map.get('nrows'), 10),
    ncols: parseInt(map.get('ncols'), 10),
    nodata: parseFloat(map.get('nodata')),
    bodyStart: i,
  }
}

function main() {
  const args = parseArgs(process.argv)
  console.log(`[geoid] reading ${args.input}`)
  const raw = readFileSync(args.input, 'utf8')
  const lines = raw.split(/\r?\n/)
  const hdr = parseHeader(lines)
  console.log(`[geoid] grid: ${hdr.nrows} rows × ${hdr.ncols} cols  range=lat[${hdr.latMin}..${hdr.latMax}] lon[${hdr.lonMin}..${hdr.lonMax}]  Δ=${hdr.dLat}/${hdr.dLon}`)

  // 全データを 1 次元配列にフラット化
  const numbers = new Float32Array(hdr.nrows * hdr.ncols)
  let idx = 0
  for (let li = hdr.bodyStart; li < lines.length && idx < numbers.length; li++) {
    const tokens = lines[li].trim().split(/\s+/)
    for (const t of tokens) {
      if (!t) continue
      const v = parseFloat(t)
      numbers[idx++] = v === hdr.nodata ? NaN : v
      if (idx >= numbers.length) break
    }
  }
  if (idx !== numbers.length) {
    console.warn(`[geoid] WARN: 読み込んだデータ数 ${idx} / 期待 ${numbers.length}`)
  }

  // クロップ
  const [latMinC, latMaxC, lonMinC, lonMaxC] = args.bbox
  const rowFrom = Math.max(0, Math.floor((hdr.latMax - latMaxC) / hdr.dLat))
  const rowTo = Math.min(hdr.nrows - 1, Math.ceil((hdr.latMax - latMinC) / hdr.dLat))
  const colFrom = Math.max(0, Math.floor((lonMinC - hdr.lonMin) / hdr.dLon))
  const colTo = Math.min(hdr.ncols - 1, Math.ceil((lonMaxC - hdr.lonMin) / hdr.dLon))
  const nrows = rowTo - rowFrom + 1
  const ncols = colTo - colFrom + 1
  const newLatMax = hdr.latMax - rowFrom * hdr.dLat
  const newLatMin = hdr.latMax - rowTo * hdr.dLat
  const newLonMin = hdr.lonMin + colFrom * hdr.dLon
  const newLonMax = hdr.lonMin + colTo * hdr.dLon
  console.log(`[geoid] crop: ${nrows} × ${ncols}  lat[${newLatMin}..${newLatMax}] lon[${newLonMin}..${newLonMax}]`)

  const cropped = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    const srcRow = rowFrom + r
    for (let c = 0; c < ncols; c++) {
      const srcCol = colFrom + c
      cropped[r * ncols + c] = numbers[srcRow * hdr.ncols + srcCol]
    }
  }

  // ヘッダ書き込み (64 bytes)
  const headerBuf = Buffer.alloc(64)
  headerBuf.write('JGRD', 0, 'ascii')
  headerBuf.writeUInt32LE(1, 4)
  headerBuf.writeDoubleLE(newLatMin, 8)
  headerBuf.writeDoubleLE(newLatMax, 16)
  headerBuf.writeDoubleLE(newLonMin, 24)
  headerBuf.writeDoubleLE(newLonMax, 32)
  headerBuf.writeDoubleLE(hdr.dLat, 40)
  headerBuf.writeDoubleLE(hdr.dLon, 48)
  headerBuf.writeUInt32LE(nrows, 56)
  headerBuf.writeUInt32LE(ncols, 60)

  // データ
  const dataBuf = Buffer.from(cropped.buffer, cropped.byteOffset, cropped.byteLength)
  const out = Buffer.concat([headerBuf, dataBuf])

  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, out)
  console.log(`[geoid] wrote ${args.output}  size=${(out.length / 1024 / 1024).toFixed(2)} MB`)
}

main()
