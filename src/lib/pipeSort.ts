// 配管番号（例: "K3", "S12", "O1", "R14", "O27"）から中央の数字部分を抽出
// ソート用: "頭文字アルファベット + 数字 + 末尾アルファベット" のうち、数字のみを比較キーにする
export function extractPipeNumberDigits(pipeNumber: string | null | undefined): number {
  if (!pipeNumber) return Number.MAX_SAFE_INTEGER
  const m = pipeNumber.match(/\d+/)
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER
}

// 配管番号を数字順にソートするコンパレータ
// 数字が同じ場合のみ頭文字で安定化
export function comparePipeNumbers(a: string | null | undefined, b: string | null | undefined): number {
  const na = extractPipeNumberDigits(a)
  const nb = extractPipeNumberDigits(b)
  if (na !== nb) return na - nb
  // 同じ数字なら頭文字で
  return (a ?? '').localeCompare(b ?? '', 'ja')
}
