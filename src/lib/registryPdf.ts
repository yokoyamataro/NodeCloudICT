// オンライン登記情報提供サービスで取得した「土地全部事項」PDF を解析し、
// 地番管理に流し込むためのフィールドを抽出する。
//
// 抽出対象:
//   ・所在 (例: 斜里郡斜里町港町)
//   ・地番 (例: "1-22" — 全角・「番」区切りを正規化)
//   ・現在の地目 (例: 宅地 / 雑種地)
//   ・現在の地積 (㎡)
//   ・現在の所有者（複数行に対応。共有も拾える）
//
// 留意事項:
//   ・PDF のテキスト抽出では「下線=抹消」の情報が失われるため、
//     各列で最後に登場した値を「現在値」として採用するヒューリスティック
//     を採る（分筆等の更新が反映される）。
//   ・所在 / 地番は PDF 内テキストよりも、ファイル名のほうが安定して
//     取得できることが多いので、ファイル名からの抽出をフォールバック
//     として併用する。

import * as pdfjs from 'pdfjs-dist'
// Vite の Worker URL 解決を使って worker をバンドル
// ※ pdfjs-dist v6 は .mjs を提供
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
}

export interface ParsedOwner {
  address: string
  fullName: string
}

export interface ParsedRegistry {
  /** ファイル名（参照用） */
  fileName: string
  /** 所在 (例: 斜里郡斜里町港町) */
  location: string | null
  /** 現在の地番 (正規化後: 半角 "N-M" 形式) */
  parcelNumber: string | null
  /** 現在の地目 */
  landCategory: string | null
  /** 現在の地積 (㎡) */
  areaSqm: number | null
  /** 現在の所有者（複数可。最新順位の登記から拾う） */
  owners: ParsedOwner[]
  /** 警告 / 抽出失敗のメモ */
  warnings: string[]
  /** デバッグ用の生テキスト */
  rawText: string
}

// 全角数字 → 半角数字
function toHalfDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  )
}

// 地番文字列を "N-M" 形式に正規化（マッチング用）
//   "１番１６" → "1-16"
//   "４３０番"  → "430"
//   "４３０－１" → "430-1"
//   "1番22"  → "1-22"
export function normalizeParcelNumber(s: string): string {
  const half = toHalfDigits(s)
  return half
    .replace(/番/g, '-')
    .replace(/[－―ー]/g, '-')
    .replace(/[\s　]/g, '')
    .replace(/-+$/, '')
}

// 所在文字列の正規化（前後空白・全角空白除去）
function normalizeLocation(s: string): string {
  return s.replace(/[\s　]+/g, '').trim()
}

// ファイル名から所在 + 地番を抽出（フォールバック用）
// 例: "斜里郡斜里町港町１－２２不動産登記（土地全部事項）..."
//   → location='斜里郡斜里町港町', parcel='1-22'
function parseFromFileName(name: string): { location: string | null; parcelNumber: string | null } {
  // 末尾の "不動産登記..." を取り除く
  const base = name.replace(/\.pdf$/i, '')
  const m = base.match(/^(.+?)([０-９]+)(?:[－―ー\-]([０-９]+))?\s*不動産登記/)
  if (!m) return { location: null, parcelNumber: null }
  const location = normalizeLocation(m[1])
  const main = toHalfDigits(m[2])
  const sub = m[3] ? toHalfDigits(m[3]) : null
  return {
    location,
    parcelNumber: sub ? `${main}-${sub}` : main,
  }
}

// 全角コロン(：) と : を統一
const COLON_RE = /[：:]/g

// 地積文字列 ("１３２：２３" や "２３００：") を ㎡ 数値へ
//   "１３２：２３" → 132.23
//   "２３００："   → 2300.00
//   "２０２３６："  → 20236
function parseArea(text: string): number | null {
  const t = toHalfDigits(text.replace(/[,，]/g, '')).replace(COLON_RE, ':')
  const m = t.match(/(\d+):(\d*)/)
  if (!m) return null
  const whole = Number(m[1])
  if (!Number.isFinite(whole)) return null
  const decText = m[2] ?? ''
  if (!decText) return whole
  const dec = Number(decText)
  if (!Number.isFinite(dec)) return whole
  return whole + dec / Math.pow(10, decText.length)
}

// pdfjs のページ TextContent から「行」を組み立てる。
// X/Y 座標で並べ替え、Y が近いものを同じ行とみなす。
async function extractLinesFromPdf(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise
  const allLines: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    // Y で大まかにまとめる（小数の揺れを吸収するため整数化）
    const buckets = new Map<number, Array<{ x: number; s: string }>>()
    for (const item of tc.items as Array<{ str: string; transform: number[] }>) {
      if (!item.str) continue
      const x = item.transform[4]
      const y = Math.round(item.transform[5])
      const arr = buckets.get(y) ?? []
      arr.push({ x, s: item.str })
      buckets.set(y, arr)
    }
    const ys = Array.from(buckets.keys()).sort((a, b) => b - a) // 上から下
    for (const y of ys) {
      const items = buckets.get(y)!.sort((a, b) => a.x - b.x)
      // テキスト結合（罫線・空白も保持）
      const line = items.map((i) => i.s).join('')
      if (line.trim() || /[│|｜]/.test(line)) allLines.push(line)
    }
  }
  return allLines
}

// 行をセクション (表題部 / 甲区 / 乙区) に分割
interface Sections {
  title: string[]
  ko: string[]
  otsu: string[]
}

function splitSections(lines: string[]): Sections {
  const isTitleHeader = (l: string) => /表[\s　]*題[\s　]*部/.test(l)
  const isKoHeader = (l: string) =>
    /権[\s　]*利[\s　]*部[\s\S]*甲[\s　]*区/.test(l) ||
    /\(\s*甲\s*区\s*\)/.test(l)
  const isOtsuHeader = (l: string) =>
    /権[\s　]*利[\s　]*部[\s\S]*乙[\s　]*区/.test(l) ||
    /\(\s*乙\s*区\s*\)/.test(l)

  let mode: 'pre' | 'title' | 'ko' | 'otsu' = 'pre'
  const out: Sections = { title: [], ko: [], otsu: [] }
  for (const line of lines) {
    if (isOtsuHeader(line)) {
      mode = 'otsu'
      continue
    }
    if (isKoHeader(line)) {
      mode = 'ko'
      continue
    }
    if (isTitleHeader(line)) {
      mode = 'title'
      continue
    }
    if (mode === 'title') out.title.push(line)
    else if (mode === 'ko') out.ko.push(line)
    else if (mode === 'otsu') out.otsu.push(line)
  }
  return out
}

// 表題部から所在 / 地番 / 地目 / 地積 を抜く
//   各列の最後に出てきた非空セルを採用する（履歴行は最新で上書きされていく前提）
function parseTitleSection(
  lines: string[],
): { location: string | null; parcelNumber: string | null; landCategory: string | null; areaSqm: number | null } {
  let location: string | null = null
  let parcelNumber: string | null = null
  let landCategory: string | null = null
  let areaSqm: number | null = null

  for (const raw of lines) {
    // 所在行: "所　在│{location}│..." を拾う
    if (/所[\s　]*在/.test(raw) && location == null) {
      // 「所在」より右、罫線で区切られた次のセルが location
      const m = raw.match(/所[\s　]*在[\s　│|｜]+([^│|｜]+)/)
      if (m) {
        const v = normalizeLocation(m[1])
        if (v) location = v
      }
    }

    // 表行: │ で分割して「地番 / 地目 / 地積」列を見る
    if (/[│|｜]/.test(raw)) {
      const cols = raw.split(/[│|｜]/).map((c) => c.trim())
      // 罫線テキストに含まれる空白セルを取り除いたあと、
      // 「番」が含まれる先頭セルを地番、「地目」候補（漢字 1〜3 字）を地目、
      // 「：」を含むセルを地積とみなす（位置はテーブルによって若干ズレるため）
      for (const c of cols) {
        if (!c) continue
        if (/[０-９]+番[０-９]*$/.test(c) || /^\d+(-\d+)?$/.test(c)) {
          // 地番
          parcelNumber = normalizeParcelNumber(c)
        } else if (/^[一-鿿]{1,4}$/.test(c)) {
          // 地目候補（純漢字のみ）。短い (1〜4 字) のセルを地目として更新
          // 「①変更」「③錯誤」などのノイズを避けるため数字や記号を除外
          landCategory = c
        } else {
          const a = parseArea(c)
          if (a != null) areaSqm = a
        }
      }
    }
  }

  return { location, parcelNumber, landCategory, areaSqm }
}

// 名前候補のセグメントを 1 文字ずつの全角空白区切りからまとめる
// "元　木　祐　二" → "元木祐二"
// "株　式　会　社　元　木　金　物　店" → "株式会社元木金物店"
function joinSpacedName(s: string): string {
  return s.replace(/[\s　│|｜]/g, '')
}

// 甲区から現在の所有者を抜く。
// 順位番号の大きい所有権移転 / 所有権保存を「現在」とみなす。
//
// 1 エントリの構造（典型例）:
//   ┃3        │所有権移転     │令和X年...│原因  令和X年...信託
//   ┃         │               │第Z号     │所有者  斜里郡斜里町港町１番地４４
//   ┃         │               │          │　元　木　祐　二
//
// → address: "斜里郡斜里町港町１番地４４", name: "元木祐二"
function parseKoSection(lines: string[]): ParsedOwner[] {
  // まず entries（順位番号で区切られたブロック）に分割
  type Entry = { rank: number; purpose: string; body: string[] }
  const entries: Entry[] = []
  let cur: Entry | null = null
  for (const raw of lines) {
    const cols = raw.split(/[│|｜]/).map((c) => c.trim())
    // 行頭セルが数字なら新規エントリ
    const head = cols[0]
    if (head && /^\d+$|^[０-９]+$/.test(toHalfDigits(head).trim())) {
      if (cur) entries.push(cur)
      cur = {
        rank: Number(toHalfDigits(head).trim()),
        purpose: cols[1] ?? '',
        body: [raw],
      }
    } else if (cur) {
      cur.body.push(raw)
      if (!cur.purpose && cols[1]) cur.purpose = cols[1]
    }
  }
  if (cur) entries.push(cur)

  // 「所有権移転 / 所有権保存」のエントリのみ採用
  const ownerEntries = entries.filter(
    (e) => /所有権移転/.test(e.purpose) || /所有権保存/.test(e.purpose),
  )
  if (ownerEntries.length === 0) return []
  ownerEntries.sort((a, b) => b.rank - a.rank)
  const latest = ownerEntries[0]

  // body の各行から、右端セル（権利者その他の事項）を抜き出して所有者を組み立てる
  const rightCells: string[] = []
  for (const raw of latest.body) {
    const cols = raw.split(/[│|｜]/).map((c) => c.trim())
    const last = cols[cols.length - 1]
    if (last) rightCells.push(last)
  }
  // "所有者　{addressLine}" を見つけ、続く非空行を住所/氏名として組み立てる
  const owners: ParsedOwner[] = []
  for (let i = 0; i < rightCells.length; i++) {
    const m = rightCells[i].match(/^(?:所有者|共有者|受託者)[\s　]+(.*)$/)
    if (!m) continue
    let address = m[1].trim()
    // 住所が次の行に続く場合がある（「番地」で終わるなど）
    let name = ''
    for (let j = i + 1; j < rightCells.length; j++) {
      const next = rightCells[j]
      // 別の所有者ブロックや「順位」「原因」「持分」が来たら停止
      if (/^(?:所有者|共有者|受託者|原因|順位|持分|信託)/.test(next)) break
      if (/[\s　]/.test(next) && /^[一-鿿゠-ヿ぀-ゟＡ-Ｚ]/.test(next)) {
        // 名前候補（全角空白区切りの漢字列）
        name = joinSpacedName(next)
        i = j
        break
      } else {
        // 住所継続
        address += next
      }
    }
    if (name) owners.push({ address: normalizeLocation(address), fullName: name })
  }
  return owners
}

export async function parseRegistryPdf(file: File): Promise<ParsedRegistry> {
  const fileMeta = parseFromFileName(file.name)
  const lines = await extractLinesFromPdf(file)
  const rawText = lines.join('\n')

  const sections = splitSections(lines)
  const title = parseTitleSection(sections.title)
  const owners = parseKoSection(sections.ko)

  const warnings: string[] = []
  const location = title.location ?? fileMeta.location
  const parcelNumber = title.parcelNumber ?? fileMeta.parcelNumber
  if (!location) warnings.push('所在を抽出できませんでした')
  if (!parcelNumber) warnings.push('地番を抽出できませんでした')
  if (!title.landCategory) warnings.push('地目を抽出できませんでした')
  if (title.areaSqm == null) warnings.push('地積を抽出できませんでした')
  if (owners.length === 0) warnings.push('所有者を抽出できませんでした')

  return {
    fileName: file.name,
    location,
    parcelNumber,
    landCategory: title.landCategory,
    areaSqm: title.areaSqm,
    owners,
    warnings,
    rawText,
  }
}
