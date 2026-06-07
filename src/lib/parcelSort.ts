// 地番番号の自然ソート。
// 「親番(整数)-小番(整数)」を分解して、
//   1. 親番（数値）
//   2. 小番（数値、null は本番扱いで先頭）
//   3. 元文字列（数値でない部分のフォールバック）
// の順で比較する。
//
// 例: ["1-12","100-1","12-3","9-2","8"] → ["1-12","8","9-2","12-3","100-1"]
//
// 数字+ハイフン+数字 以外の文字列（"A-1" など）は非数値扱いとして末尾に押しやり、
// 同じ非数値同士は元文字列で localeCompare する。

export interface ParsedParcelNumber {
  parent: number
  sub: number | null
  original: string
}

export function parseParcelNumber(s: string | null | undefined): ParsedParcelNumber {
  if (!s) return { parent: Number.POSITIVE_INFINITY, sub: null, original: '' }
  const m = s.match(/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/)
  if (!m) return { parent: Number.POSITIVE_INFINITY, sub: null, original: s }
  const parent = Number(m[1])
  const sub = m[2] != null ? Number(m[2]) : null
  return { parent, sub, original: s }
}

export function compareParcelNumber(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseParcelNumber(a)
  const pb = parseParcelNumber(b)
  if (pa.parent !== pb.parent) return pa.parent - pb.parent
  // 同じ親番: 小番なし(null) を本番として先頭に置く
  const sa = pa.sub ?? -1
  const sb = pb.sub ?? -1
  if (sa !== sb) return sa - sb
  return pa.original.localeCompare(pb.original, 'ja')
}

/**
 * 地番一覧用の複合キー比較。
 * 1. 所在 (空文字は先頭) を localeCompare(ja)
 * 2. 同所在のなかでは compareParcelNumber
 */
export function compareByLocationAndParcel(
  a: { location?: string | null; parcel_number?: string | null },
  b: { location?: string | null; parcel_number?: string | null },
): number {
  const la = (a.location ?? '').trim()
  const lb = (b.location ?? '').trim()
  if (la !== lb) {
    // 空 (所在未設定) は先頭に
    if (!la) return -1
    if (!lb) return 1
    return la.localeCompare(lb, 'ja')
  }
  return compareParcelNumber(a.parcel_number ?? null, b.parcel_number ?? null)
}
