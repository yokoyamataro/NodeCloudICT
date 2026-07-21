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
//
// 登記簿の基本フォーマットは
//
//   所有者　{住所}
//   {氏名（文字間に全角スペースが入ることがある）}
//
// なので、line-based に「所有者」始まりの行を見つけ、その住所と、
// 次の非ノイズ行の氏名をペアにする。最後に登場するペアを「現在の所有者」
// として採用する（複数登記の連続にも対応）。
function extractOwners(text: string): ParsedOwner[] {
  // 末尾に出てくる注意書き（凡例）はオーナー名扱いされないよう、ここで切り捨てる。
  // 例:
  //   *「登記の目的」欄に「相続人申告」と記載されている登記は、所有権の登記名義人（所有者）の相続人からの申出に基づき、登記官が職権で、...
  //   *下線のあるものは抹消事項であることを示す。
  //
  // pdfjs での抽出によっては先頭の「*」が全角「＊」になったり、別の Y 座標で
  // 「*」と本文が別行になることがある。記号に頼らず、フッタにしか出てこない
  // 特徴フレーズで切る。
  const footerPhraseRe =
    /(?:「[\s　]*登記の目的[\s　]*」|下線[\s　]*のあるもの|登記官[\s　]*が[\s　]*職権|相続人[\s　]*からの[\s　]*申出|権利[\s　]*関係を[\s　]*公示|抹消事項であることを示)/
  const footerMatch = text.match(footerPhraseRe)
  if (footerMatch && footerMatch.index !== undefined) {
    text = text.slice(0, footerMatch.index)
  }

  // 行ごとに整形（罫線除去・全半角空白の正規化）
  const cleanLine = (l: string) =>
    l
      .replace(/[─-╿│|｜]+/g, ' ')
      .replace(/[\s　]+/g, ' ')
      .trim()

  // ノイズ行: 「順位N番の登記を移記」「平成X年法務省令...」「原因 ...」「移記」など
  const isNoise = (l: string) => {
    if (!l) return true
    if (/^[*※＊]/.test(l)) return true
    if (/順位[０-９0-9]+番の登記/.test(l)) return true
    if (/法務省令/.test(l)) return true
    if (/移記$/.test(l)) return true
    if (/^(?:原因|順位|乙[\s　]*区|権[\s　]*利[\s　]*部|抹消|信託)/.test(l)) return true
    // 「平成X年X月X日」のみの行
    if (/^[平令昭]和?[０-９0-9一二三四五六七八九十元]+年/.test(l) && !/[一-龥ぁ-んァ-ヶ]{2,}/.test(l.replace(/[平令昭]和?[０-９0-9一二三四五六七八九十元年月日 　\d-]+/, ''))) return true
    return false
  }

  // 住所行末尾が地名語で終わっていれば次の行は住所継続
  const continuesAddress = (s: string) =>
    /(?:丁目|番地|番|号|市|町|村|区|郡|条|大字|字|地番|府|県|都|道|外|地)$/.test(s)

  const lines = text.split(/\r?\n/).map(cleanLine).filter((l) => l.length > 0)

  const found: ParsedOwner[] = []
  // pdfjs は同じ Y の他カラムテキスト（例: 「第1062号」）と「所有者」を
  // 1 行にまとめがちなので、行頭固定にせず行のどこに出てきても拾う。
  // 直前は行頭 or 空白 / 句読点 / 罫線（既に半角空白へ正規化済み）に限定。
  const ownerInlineRe = /(?:^|[\s　、。│])((?:所有者|共有者))[\s　]*(.+)$/

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ownerInlineRe)
    if (!m) continue
    // 「登記名義人（所有者）」のような誤マッチを避けるため、直後が `）` のときはスキップ
    const tail = m[2]
    if (tail.startsWith(')') || tail.startsWith('）')) continue
    let address = tail.replace(/[\s　]/g, '')
    if (!address) continue
    let name: string | null = null

    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      // 次の所有者宣言が来たら終了
      if (/(?:^|[\s　])(?:所有者|共有者|受託者)/.test(next)) break
      if (isNoise(next)) {
        j++
        continue
      }
      // 住所継続: 末尾が地名語 → 結合してさらに次へ
      if (continuesAddress(address)) {
        address += next.replace(/[\s　]/g, '')
        j++
        continue
      }
      // ここに到達した行を氏名とみなす（文字間スペースがあっても joinSpacedName で詰める）
      name = joinSpacedName(next)
      break
    }

    if (name) found.push({ address, fullName: name })
  }

  // 最後のペアを「現在の所有者」として返す
  return found.length > 0 ? [found[found.length - 1]] : []
}

// ============================================================
// 所有者事項 (¥140) PDF 用のシンプルパーサ
// ============================================================
//
// 「所有者事項」PDF は 全部事項 と構造がまったく異なる:
//   ・地目 / 地積 は含まれない (所有者だけ)
//   ・レイアウトは「住所 | 氏名」の 2 列テーブルのみ
//   ・ヘッダ (「2026/07/21 12:23 現在の情報です。」等) を area/owner 抽出の
//     ヒューリスティックが誤マッチしがちなので、専用ロジックで処理する
//
// アプローチ: X 座標で「住所列」「氏名列」を分割し、ヘッダ行より下の各 Y 行を
// 左右に分けてペアリングする。
export async function parseOwnershipPdf(file: File): Promise<ParsedRegistry> {
  const fileMeta = parseFromFileName(file.name)
  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise

  // (x, y, s) の生アイテムを収集
  const items: Array<{ x: number; y: number; s: string }> = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    for (const item of tc.items as Array<{
      str: string
      transform: number[]
    }>) {
      if (!item.str) continue
      items.push({
        x: item.transform[4],
        y: Math.round(item.transform[5]),
        s: item.str,
      })
    }
  }

  // Y でグルーピング (行として扱う)
  const yBuckets = new Map<number, Array<{ x: number; s: string }>>()
  for (const it of items) {
    const arr = yBuckets.get(it.y) ?? []
    arr.push({ x: it.x, s: it.s })
    yBuckets.set(it.y, arr)
  }
  const yList = Array.from(yBuckets.keys()).sort((a, b) => b - a) // 上→下

  // 「住所」「氏名」ヘッダ行を探す。両方が同じ Y に居るはず。
  let headerY: number | null = null
  let jushoX: number | null = null
  let shimeiX: number | null = null
  for (const y of yList) {
    const row = yBuckets.get(y)!
    const joined = row.map((i) => i.s).join('')
    if (/住[\s　]*所/.test(joined) && /氏[\s　]*名/.test(joined)) {
      headerY = y
      // 各語のおおよその X 位置を拾う
      for (const it of row) {
        const s = it.s.replace(/[\s　]/g, '')
        if (s.includes('住所') && jushoX == null) jushoX = it.x
        if (s.includes('氏名') && shimeiX == null) shimeiX = it.x
      }
      // 語がバラバラの item に分かれている場合の fallback: 「住」「氏」の X を使う
      if (jushoX == null || shimeiX == null) {
        for (const it of row) {
          if (jushoX == null && /住/.test(it.s)) jushoX = it.x
          if (shimeiX == null && /氏/.test(it.s)) shimeiX = it.x
        }
      }
      break
    }
  }

  const owners: ParsedOwner[] = []
  if (headerY !== null && jushoX !== null && shimeiX !== null) {
    // 左右列の中間 X で行を分割
    const midX = (jushoX + shimeiX) / 2
    // ヘッダより下 (Y が小さい) の行だけ処理
    const dataYs = yList.filter((y) => y < headerY)
    for (const y of dataYs) {
      const row = yBuckets.get(y)!
      const left = row
        .filter((i) => i.x < midX)
        .sort((a, b) => a.x - b.x)
        .map((i) => i.s)
        .join('')
        .replace(/[│|｜┃─-╿\s　]/g, '')
      const right = row
        .filter((i) => i.x >= midX)
        .sort((a, b) => a.x - b.x)
        .map((i) => i.s)
        .join('')
        .replace(/[│|｜┃─-╿\s　]/g, '')
      // 罫線のみの行や、片方だけしか無い行は無視
      if (!left || !right) continue
      // フッタ (「*下線のあるものは...」等) を除外
      if (/^[*※＊]/.test(left) || /下線|抹消|注記/.test(left)) continue
      owners.push({ address: left, fullName: joinSpacedName(right) })
    }
  }

  // 所在 / 地番: ファイル名優先、なければヘッダから雑に抽出
  let location: string | null = fileMeta.location
  let parcelNumber: string | null = fileMeta.parcelNumber
  const rawText = yList
    .map((y) =>
      yBuckets
        .get(y)!
        .sort((a, b) => a.x - b.x)
        .map((i) => i.s)
        .join(''),
    )
    .join('\n')
  if (!location) location = extractLocation(rawText)
  if (!parcelNumber) parcelNumber = extractParcelNumber(rawText)

  const warnings: string[] = []
  if (owners.length === 0) warnings.push('所有者を抽出できませんでした')
  if (!location) warnings.push('所在を抽出できませんでした')
  if (!parcelNumber) warnings.push('地番を抽出できませんでした')

  return {
    fileName: file.name,
    location,
    parcelNumber,
    landCategory: null, // 所有者事項 PDF には地目情報なし
    areaSqm: null, // 所有者事項 PDF には地積情報なし
    owners,
    warnings,
    rawText,
  }
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
