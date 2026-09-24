/**
 * 表計算 ソフト から の 貼り付け (TSV) を グリッド表 に 合わせる。
 *
 * 表計算 の コピー は 「タブ 区切り + 改行」。 貼り付け 方 は 2 通り ある。
 *   1. 見出し 付き … 1 行目 に 線名 (A,B,F…)、 1 列目 に 測点名 が ある 塊。
 *      名前 で 突き合わせる ので、 並び が 違って も、 一部 だけ でも 入る。
 *   2. 数字 だけ … 選んで いる セル を 左上 と して 順 に 流し込む。
 *
 * 空 の セル は 「消す」 (null)。 表計算 で 空白 を 貼った とき と 同じ。
 */

/** 貼り付け 先 の 形 */
export interface GridPasteTarget {
  /** 列 (平行縦断) の 名前。 左 から 右 */
  lineNames: string[]
  /** 行 (測点) の 名前。 上 から 下 */
  stationLabels: string[]
  /** 見出し が 無い とき の 起点 */
  anchorRow: number
  anchorCol: number
}

/** 入れる 値 1 つ。 row / col は 貼り付け 先 の 並び の 位置 */
export interface GridPasteCell {
  row: number
  col: number
  /** null は 「消す」 */
  value: number | null
}

export interface GridPasteResult {
  cells: GridPasteCell[]
  /** 1 行目 を 線名 の 見出し と して 使った か */
  usedHeader: boolean
  /** 1 列目 を 測点名 と して 使った か */
  usedLabels: boolean
  /** 入れられ なかった セル の 数 (数字 で ない / 表 の 外) */
  skipped: number
}

const norm = (s: string) => s.trim().toLowerCase()

/** タブ 区切り の 文字列 を 行 × 列 に する。 末尾 の 空行 は 捨てる */
export function parseTsv(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return []
  return lines.map((l) => l.split('\t'))
}

/**
 * 数字 に する。 表計算 由来 の 桁区切り と 全角 は 落とす。
 * 数字 で なければ null を 返す (空文字 は 呼ぶ 側 で 判定 する)。
 */
function toNumber(raw: string): number | null {
  const t = raw
    .trim()
    .replace(/,/g, '')
    .replace(/[０-９．＋－]/g, (c) =>
      c === '．' ? '.' : c === '＋' ? '+' : c === '－' ? '-' : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
  if (t === '') return null
  const v = parseFloat(t)
  if (!Number.isFinite(v)) return null
  return Math.round(v * 1000) / 1000
}

/** 貼り付け た 塊 を 表 の 位置 に 割り当てる */
export function alignTsvToGrid(text: string, target: GridPasteTarget): GridPasteResult {
  const rows = parseTsv(text)
  const out: GridPasteResult = { cells: [], usedHeader: false, usedLabels: false, skipped: 0 }
  if (rows.length === 0) return out

  const lineIdxByName = new Map(target.lineNames.map((n, i) => [norm(n), i]))
  const rowIdxByLabel = new Map(target.stationLabels.map((n, i) => [norm(n), i]))

  // 1 行目 が 線名 の 並び か を 見る
  const head = rows[0]
  let colMap: (number | null)[] | null = null
  let labelCol = -1
  let dataStart = 0
  if (head.some((c) => lineIdxByName.has(norm(c)))) {
    // 先頭 が 線名 で なければ そこ は 測点名 の 列
    labelCol = lineIdxByName.has(norm(head[0])) ? -1 : 0
    colMap = head.map((c, j) => (j === labelCol ? null : (lineIdxByName.get(norm(c)) ?? null)))
    dataStart = 1
    out.usedHeader = true
  } else if (rowIdxByLabel.has(norm(head[0] ?? ''))) {
    // 見出し は 無い が 1 列目 が 測点名 の 塊
    labelCol = 0
  }
  out.usedLabels = labelCol >= 0

  for (let r = dataStart; r < rows.length; r++) {
    const fields = rows[r]
    if (fields.length === 0 || (fields.length === 1 && fields[0].trim() === '')) continue

    let row: number
    if (labelCol >= 0) {
      const hit = rowIdxByLabel.get(norm(fields[labelCol] ?? ''))
      if (hit == null) {
        // 知ら ない 測点 の 行 は まるごと 飛ばす
        out.skipped += fields.filter((c, j) => j !== labelCol && c.trim() !== '').length
        continue
      }
      row = hit
    } else {
      row = target.anchorRow + (r - dataStart)
    }
    if (row < 0 || row >= target.stationLabels.length) {
      out.skipped += fields.filter((c, j) => j !== labelCol && c.trim() !== '').length
      continue
    }

    for (let j = 0; j < fields.length; j++) {
      if (j === labelCol) continue
      const col = colMap
        ? colMap[j]
        : target.anchorCol + (labelCol >= 0 ? j - labelCol - 1 : j)
      const raw = fields[j]
      if (col == null || col < 0 || col >= target.lineNames.length) {
        if (raw.trim() !== '') out.skipped++
        continue
      }
      if (raw.trim() === '') {
        out.cells.push({ row, col, value: null })
        continue
      }
      const v = toNumber(raw)
      if (v == null) {
        out.skipped++
        continue
      }
      out.cells.push({ row, col, value: v })
    }
  }
  return out
}

/** 表 を TSV に する (見出し 付き)。 コピー 用 */
export function gridToTsv(
  lineNames: string[],
  stationLabels: string[],
  valueAt: (row: number, col: number) => number | null,
  headLabel = '測点',
): string {
  const lines = [[headLabel, ...lineNames].join('\t')]
  for (let r = 0; r < stationLabels.length; r++) {
    const cells = lineNames.map((_, c) => {
      const v = valueAt(r, c)
      return v == null ? '' : v.toFixed(3)
    })
    lines.push([stationLabels[r], ...cells].join('\t'))
  }
  return lines.join('\n')
}
