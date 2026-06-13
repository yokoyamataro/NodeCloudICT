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

// 不動産登記規則 第99条の 23 地目
const KNOWN_LAND_CATEGORIES = [
  '田', '畑', '宅地', '学校用地', '鉄道用地', '塩田', '鉱泉地', '池沼',
  '山林', '牧場', '原野', '墓地', '境内地', '運河用地', '水道用地',
  '用悪水路', 'ため池', '堤', '井溝', '保安林', '公衆用道路', '公園',
  '雑種地',
]

// テキスト中に出てきた地目のうち、もっとも最後（≒最新）のものを返す。
// 罫線・改行に依存せず、文字列全体を走査する。
function findLastLandCategory(text: string): string | null {
  // 長いものから優先（"雑種地" を "山林" の前に試す）
  const cats = [...KNOWN_LAND_CATEGORIES].sort((a, b) => b.length - a.length)
  const re = new RegExp(
    '(' + cats.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'g',
  )
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const cat = m[1]
    const before = text[m.index - 1] ?? ' '
    const after = text[m.index + cat.length] ?? ' '
    // 漢字に挟まれた偶発一致は捨てる
    if (/[一-龥]/.test(before) || /[一-龥]/.test(after)) continue
    last = cat
  }
  return last
}

// テキスト中の「(数字):(数字)」パターンのうち、最後（最新）のものを ㎡ 値で返す。
// 例: "２０２３６：", "２３００：", "１３２：２３"
function findLastAreaPattern(text: string): number | null {
  const normalized = toHalfDigits(text.replace(/[,，]/g, '')).replace(/[：:]/g, ':')
  const re = /(\d{1,7}):(\d{0,2})(?!\d)/g
  let last: number | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(normalized)) !== null) {
    const whole = Number(m[1])
    if (!Number.isFinite(whole)) continue
    // 単独 ":" は除外（whole が空のはずなので来ない）
    const decText = m[2]
    const decDigits = decText.length
    const dec = decText ? Number(decText) : 0
    if (!Number.isFinite(dec)) continue
    last = whole + (decDigits > 0 ? dec / Math.pow(10, decDigits) : 0)
  }
  return last
}

// 所在行を全文から取り出す（罫線なしでも動く）。
function extractLocation(text: string): string | null {
  // "所　　在　{location}" 形式（pdfjs が罫線を落とした場合の保険）
  const m =
    text.match(/所[\s　]*在[\s　│|｜]+([^\n│|｜]+)/) ||
    text.match(/所[\s　]*在[\s　]+([^\n]+)/)
  if (!m) return null
  const v = normalizeLocation(m[1])
  return v || null
}

// 地番を全文から取り出す（フォールバック用）。
function extractParcelNumber(text: string): string | null {
  // "４３０番１" のような最後の出現を取る
  const re = /([０-９0-9]+)番([０-９0-9]+)?/g
  let last: { main: string; sub: string | null } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    last = { main: toHalfDigits(m[1]), sub: m[2] ? toHalfDigits(m[2]) : null }
  }
  if (!last) return null
  return last.sub ? `${last.main}-${last.sub}` : last.main
}

// 全角空白区切りの名前を結合
//   "元　木　祐　二" → "元木祐二"
//   "株　式　会　社　元　木　金　物　店" → "株式会社元木金物店"
function joinSpacedName(s: string): string {
  return s.replace(/[\s　│|｜┃]/g, '')
}

// 甲区テキストから所有者ブロックを抽出する。
// 各「所有者 / 共有者」記述の後ろの「住所...氏名」をひとまとめにする。
//
// 罫線（│, ┃）が pdfjs で落ちる PDF にも対応するため、テキスト全体を
// 走査して "所有者[空白]+...次の停止語まで" を捕まえる方針にする。
function extractOwners(text: string): ParsedOwner[] {
  // 末尾に出てくる注意書き（凡例）はオーナー名扱いされないよう、ここで切り捨てる。
  //   *「登記の目的」欄に「相続人申告」と記載されている登記は、...
  //   *下線のあるものは抹消事項であることを示す。
  //   *「順位番号」欄... / *「権利者その他の事項」欄...
  // のように先頭が「*」または「※」のフットノートが続くので、最初の出現で打ち切る。
  const footerRe = /[*※][\s　]*(?:「|下線|順位|権利)/
  const footerMatch = text.match(footerRe)
  if (footerMatch && footerMatch.index !== undefined) {
    text = text.slice(0, footerMatch.index)
  }

  // 「所有者」/ 「共有者」が始まりのキー。
  // 信託の「受託者」は所有者ではない（信託目録）ので除外。
  // 停止語: 次の所有者宣言、原因/順位/持分/信託(目録は除く)/権利部/乙区
  // 末尾の注意書き(*〜) も停止語に含める（フッタ削除で取りきれない揺れの保険）
  const stopRe =
    '所有者|共有者|受託者|原因[\\s　]|順位[\\s　]*番号|順位[０-９0-9]+番|持分|信託(?!目)|乙[\\s　]*区|権[\\s　]*利[\\s　]*部|[*※][\\s　]*[「下順権]'
  const ownerRe = new RegExp(
    '(?:所有者|共有者)[\\s　]+([\\s\\S]+?)(?=' + stopRe + ')',
    'g',
  )
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = ownerRe.exec(text)) !== null) {
    blocks.push(m[1])
  }
  if (blocks.length === 0) return []

  // 最後のブロックを「現在」として採用
  const block = blocks[blocks.length - 1]
  return parseOwnerBlock(block)
}

// 1 つの所有者ブロックを「住所 ＋ 氏名（1 名以上）」に分解する。
function parseOwnerBlock(block: string): ParsedOwner[] {
  // 改行で分割し、罫線・余分な空白を取り除く。
  // 罫線は U+2500–U+257F の Box Drawing ブロックを丸ごと対象にする
  // （└ ┘ ─ ━ ┴ ┬ ├ ┤ ┼ など、列挙漏れがあった文字も拾えるように）。
  const rawLines = block
    .split(/\r?\n/)
    .map((l) => l.replace(/[─-╿│|｜\s]+/g, ' ').trim())
    .filter((l) => l && !/^[\s　]*$/.test(l))
  if (rawLines.length === 0) return []

  // 住所継続を判定するヒント:
  //   末尾が「丁目」「番」「号」「番地」「市」「町」「村」「区」「県」「府」「都」など → 続く
  //   名前候補: 全角空白で文字が区切られている / "株式会社" などの会社接頭・接尾
  const continuesAddress = (s: string) => {
    return /(?:丁目|番地|番|号|市|町|村|区|郡|条|大字|字|地番|府|県|都|道|外|地)$/.test(
      s.replace(/[\s　]+$/, ''),
    )
  }

  // 末尾から名前候補を探す: 最後の非住所行を名前とする
  const owners: ParsedOwner[] = []
  // 単純化: 最後の 1 名のみ抜く（共有は今後の改善対象）
  // 住所 = 最後の行を除いた全行を連結
  // 氏名 = 最後の行
  let addressLines: string[] = []
  let name: string | null = null
  for (const line of rawLines) {
    if (name) break
    // 「順位N番の登記を移記」「平成X年法務省令...」などの注記は除外
    if (/順位[０-９0-9]+番の登記/.test(line)) continue
    if (/法務省令/.test(line)) continue
    if (/移記$/.test(line)) continue
    if (/[平令昭]和?[０-９0-9一二三四五六七八九十元]+年/.test(line) && !/^[一-龥ぁ-んァ-ヶＡ-Ｚ々]/.test(line)) {
      // 日付行はスキップ
      continue
    }
    // 「*」「※」で始まるフッタ注記はスキップ（extractOwners 側で切るが念のため）
    if (/^[*※]/.test(line)) continue
    addressLines.push(line)
  }
  // 最後の行を名前候補とする
  if (addressLines.length >= 1) {
    const lastIdx = addressLines.length - 1
    // 末尾が住所継続パターンなら、その行も含めて名前は無し
    if (continuesAddress(addressLines[lastIdx])) {
      // 名前が見つからない → 諦め
    } else {
      name = joinSpacedName(addressLines[lastIdx])
      addressLines = addressLines.slice(0, -1)
    }
  }

  const address = addressLines.join('').replace(/[\s　]/g, '')
  if (name && name.length > 0) {
    owners.push({ address, fullName: name })
  }
  return owners
}

export async function parseRegistryPdf(file: File): Promise<ParsedRegistry> {
  const fileMeta = parseFromFileName(file.name)
  const lines = await extractLinesFromPdf(file)
  const rawText = lines.join('\n')

  // 表題部 / 甲区 / 乙区 のセクション境界を見つけて、地目・地積は
  // 「権利部の前」、所有者は「甲区」だけを対象にスキャンする。
  // 区切り語が見つからない壊れた抽出にも対応するため、見つからない時は
  // 全文を対象にする。
  const koMatch = rawText.match(/権[\s　]*利[\s　]*部[\s\S]{0,30}甲[\s　]*区/)
  const otsuMatch = rawText.match(/権[\s　]*利[\s　]*部[\s\S]{0,30}乙[\s　]*区/)
  const koIdx = koMatch ? rawText.indexOf(koMatch[0]) : -1
  const otsuIdx = otsuMatch ? rawText.indexOf(otsuMatch[0]) : -1

  const titleText = koIdx >= 0 ? rawText.substring(0, koIdx) : rawText
  const koText =
    koIdx >= 0
      ? rawText.substring(koIdx, otsuIdx > koIdx ? otsuIdx : rawText.length)
      : rawText

  // 所在
  let location = extractLocation(titleText) ?? extractLocation(rawText)
  if (!location) location = fileMeta.location

  // 地番（ファイル名を優先、なければテキストから）
  let parcelNumber = fileMeta.parcelNumber
  if (!parcelNumber) {
    const fromText = extractParcelNumber(titleText)
    if (fromText) parcelNumber = fromText
  }

  // 地目: 表題部内の既知地目の最後の出現
  const landCategory = findLastLandCategory(titleText)

  // 地積: 表題部内の (digits):(digits) パターンの最後の出現
  const areaSqm = findLastAreaPattern(titleText)

  // 所有者: 甲区を走査
  const owners = extractOwners(koText)

  const warnings: string[] = []
  if (!location) warnings.push('所在を抽出できませんでした')
  if (!parcelNumber) warnings.push('地番を抽出できませんでした')
  if (!landCategory) warnings.push('地目を抽出できませんでした')
  if (areaSqm == null) warnings.push('地積を抽出できませんでした')
  if (owners.length === 0) warnings.push('所有者を抽出できませんでした')

  return {
    fileName: file.name,
    location,
    parcelNumber,
    landCategory,
    areaSqm,
    owners,
    warnings,
    rawText,
  }
}
