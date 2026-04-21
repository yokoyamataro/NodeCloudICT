// 配管番号（例: "K3", "S12", "O1", "R14", "O27", "J1-1a", "J1-1b"）から
// 数字の列と末尾文字を抽出して比較するためのヘルパー。
// ソート優先順位:
//   1. 最初に現れる数字 → 2 番目の数字 → ...
//   2. 数字がすべて同じなら、全体の文字列（末尾のアルファベットなど）を比較
interface PipeNumberParts {
  nums: number[]
  raw: string
}

function parsePipeNumber(num: string | null | undefined): PipeNumberParts {
  const raw = num ?? ''
  const matches = raw.match(/\d+/g) ?? []
  const nums = matches.map((m) => parseInt(m, 10)).filter((n) => Number.isFinite(n))
  return { nums, raw }
}

// 後方互換: 最初に出てくる数字のみ抽出
export function extractPipeNumberDigits(pipeNumber: string | null | undefined): number {
  const { nums } = parsePipeNumber(pipeNumber)
  return nums.length > 0 ? nums[0] : Number.MAX_SAFE_INTEGER
}

// 配管番号を数字優先でソートするコンパレータ
// 例:
//   "O1" < "S2" < "O3" < "K12"
//   "J1-1a" と "J1-1b" は数字が同じ [1,1] なので raw 文字列で比較 → J1-1a < J1-1b
//   "J1" < "J1-1a"（短い方が先）
export function comparePipeNumbers(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parsePipeNumber(a)
  const pb = parsePipeNumber(b)

  // 数字を順に比較。片方が短ければその方が先。
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i]
    const nb = pb.nums[i]
    if (na === undefined && nb === undefined) break
    if (na === undefined) return -1
    if (nb === undefined) return 1
    if (na !== nb) return na - nb
  }
  // 数字がすべて同じなら、末尾文字（J1-1a と J1-1b のような差）で比較
  return pa.raw.localeCompare(pb.raw, 'ja')
}
