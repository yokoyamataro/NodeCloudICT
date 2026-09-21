// 法務局備付 登記 CSV (BM 形式) の 読込 と パース。
//
// 想定入力: 20230905_4600_A1291_NNN_BM.csv および _ERR_BM.csv。
// 文字コード は Shift-JIS。CSV は「1 物件 = 複数行」構造で、行の
// 第 1 列 = 連番 (全角数字)、第 2 列 = 種別 (物件情報 / 所在N /
// 表示履歴N / 所有権N / 甲区N / 乙区N)。連番 でグルーピング する。

import Encoding from 'encoding-japanese'

export interface RegistryProperty {
  seq: number
  kind: string          // 物件種別 (土地 / 建物)
  status: string        // 既存 / 登記済 など
  location: string      // 所在
  parcelNumber: string  // 地番
  realEstateNumber: string
  extra: string         // 末尾の管理コード
}

export interface RegistryLocation {
  order: number
  value: string
  changeReason: string
  registeredAt: string
}

export interface RegistryDisplayHistory {
  order: number
  parcelNumber: string
  landCategory: string
  areaText: string
  reason: string
  causeDate: string
}

export interface RegistryOwnership {
  order: number
  address: string
  share: string
  ownerName: string
  extra: string
  receivedAt: string
  receiptNumber: string
}

// 甲区 (所有権に関する事項) と 乙区 (所有権以外) は同じ構造で扱う
export interface RegistryRightsEntry {
  order: number
  rank: string        // 順位番号 (例: "２" "１付記１号")
  purpose: string     // 登記の目的
  receivedAt: string
  receiptNumber: string
  detail: string      // 原因 / 権利者 / 債務者などの本文
}

export interface RegistryRecord {
  seq: number
  property: RegistryProperty | null
  locations: RegistryLocation[]
  displayHistories: RegistryDisplayHistory[]
  ownerships: RegistryOwnership[]
  kouku: RegistryRightsEntry[]
  otoku: RegistryRightsEntry[]
}

export interface RegistryCsvParseResult {
  records: RegistryRecord[]
  warnings: string[]
}

export async function readRegistryCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const unicodeArray = Encoding.convert(Array.from(bytes), {
    to: 'UNICODE',
    from: 'AUTO',
  })
  return Encoding.codeToString(unicodeArray)
}

function splitCsvLine(line: string): string[] {
  // クォート対応の CSV 分割。BM 形式は基本クォート無しだが、詳細列で
  // カンマを含む余地があるため念のため対応。
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

// 全角数字 → 半角数字
function fw2hw(s: string): string {
  return s.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30),
  )
}

function parseIntSafe(text: string): number | null {
  const n = parseInt(fw2hw(text), 10)
  return Number.isFinite(n) ? n : null
}

const RE_LOCATION = /^所在(\d+)$/
const RE_DISPLAY = /^表示履歴(\d+)$/
const RE_OWNERSHIP = /^所有権(\d+)$/
const RE_KOUKU = /^甲区(\d+)$/
const RE_OTOKU = /^乙区(\d+)$/

export function parseRegistryCsv(text: string): RegistryCsvParseResult {
  const lines = text.split(/\r?\n/)
  const map = new Map<number, RegistryRecord>()
  const warnings: string[] = []

  const ensure = (seq: number): RegistryRecord => {
    let r = map.get(seq)
    if (!r) {
      r = {
        seq,
        property: null,
        locations: [],
        displayHistories: [],
        ownerships: [],
        kouku: [],
        otoku: [],
      }
      map.set(seq, r)
    }
    return r
  }

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue
    const cols = splitCsvLine(raw)
    const seq = parseIntSafe(cols[0] ?? '')
    if (seq == null) continue
    const kindText = fw2hw((cols[1] ?? '').trim())

    if (kindText === '物件情報') {
      ensure(seq).property = {
        seq,
        kind: cols[2] ?? '',
        status: cols[3] ?? '',
        location: cols[4] ?? '',
        // 地番 / 不動産番号 は 全角数字 を 半角 に 直す
        parcelNumber: fw2hw(cols[5] ?? ''),
        realEstateNumber: fw2hw(cols[6] ?? ''),
        extra: cols[10] ?? '',
      }
      continue
    }

    let m: RegExpExecArray | null
    if ((m = RE_LOCATION.exec(kindText))) {
      ensure(seq).locations.push({
        order: parseInt(m[1], 10) || 0,
        value: cols[2] ?? '',
        changeReason: cols[6] ?? '',
        registeredAt: cols[7] ?? '',
      })
      continue
    }
    if ((m = RE_DISPLAY.exec(kindText))) {
      ensure(seq).displayHistories.push({
        order: parseInt(m[1], 10) || 0,
        // 地番 / 地積 は 全角数字 を 半角 に 直す
        parcelNumber: fw2hw(cols[2] ?? ''),
        landCategory: cols[4] ?? '',
        areaText: fw2hw(cols[5] ?? ''),
        reason: cols[6] ?? '',
        causeDate: cols[7] ?? '',
      })
      continue
    }
    if ((m = RE_OWNERSHIP.exec(kindText))) {
      ensure(seq).ownerships.push({
        order: parseInt(m[1], 10) || 0,
        address: cols[2] ?? '',
        share: cols[3] ?? '',
        ownerName: cols[4] ?? '',
        extra: cols[5] ?? '',
        receivedAt: cols[6] ?? '',
        receiptNumber: cols[7] ?? '',
      })
      continue
    }
    if ((m = RE_KOUKU.exec(kindText))) {
      ensure(seq).kouku.push({
        order: parseInt(m[1], 10) || 0,
        rank: cols[2] ?? '',
        purpose: cols[3] ?? '',
        receivedAt: cols[6] ?? '',
        receiptNumber: cols[7] ?? '',
        detail: cols[8] ?? '',
      })
      continue
    }
    if ((m = RE_OTOKU.exec(kindText))) {
      ensure(seq).otoku.push({
        order: parseInt(m[1], 10) || 0,
        rank: cols[2] ?? '',
        purpose: cols[3] ?? '',
        receivedAt: cols[6] ?? '',
        receiptNumber: cols[7] ?? '',
        detail: cols[8] ?? '',
      })
      continue
    }
  }

  const records = Array.from(map.values()).sort((a, b) => a.seq - b.seq)
  for (const r of records) {
    r.locations.sort((a, b) => a.order - b.order)
    r.displayHistories.sort((a, b) => a.order - b.order)
    r.ownerships.sort((a, b) => a.order - b.order)
    r.kouku.sort((a, b) => a.order - b.order)
    r.otoku.sort((a, b) => a.order - b.order)
  }
  return { records, warnings }
}

// 一覧向けの派生値。地目 と 地積 は 別々 の 列 に 「最新 の 非空値」 を 拾う。
// (最新行 が 分筆 で 地積 だけ 更新 → 地目 は 空 の ケース が ある ため)
export function latestDisplay(r: RegistryRecord): {
  landCategory: string
  areaText: string
} {
  let landCategory = ''
  let areaText = ''
  for (const d of r.displayHistories) {
    if (d.landCategory) landCategory = d.landCategory
    if (d.areaText) areaText = d.areaText
  }
  return { landCategory, areaText }
}

export function ownerSummary(r: RegistryRecord): string {
  return r.ownerships
    .map((o) => o.ownerName)
    .filter(Boolean)
    .join('、')
}
