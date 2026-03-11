/**
 * SIMAフォーマットパーサー
 * 測量データ交換フォーマット（SIMA）を解析
 *
 * SIMA形式の座標レコード:
 * A01,番号,点名,X座標,Y座標,Z座標,
 */

export interface SimaCoordinate {
  index: number
  pointNumber: string
  x: number
  y: number
  z: number | null
}

export interface SimaParseResult {
  coordinates: SimaCoordinate[]
  projectName: string | null
  system: number | null // 座標系番号
}

/**
 * SIMAファイルをパース
 * Shift-JISエンコーディングに対応
 */
export function parseSima(content: string): SimaParseResult {
  const lines = content.split(/\r?\n/).filter(line => line.trim())
  const coordinates: SimaCoordinate[] = []
  let projectName: string | null = null
  let system: number | null = null

  for (const line of lines) {
    const parts = line.split(',')
    const recordType = parts[0]?.trim()

    switch (recordType) {
      case 'G00':
        // ヘッダーレコード（プロジェクト名）
        if (parts[2]) {
          projectName = parts[2].trim()
        }
        break

      case 'Z01':
        // 座標系番号
        if (parts[1]) {
          const num = parseInt(parts[1].trim())
          if (!isNaN(num)) {
            system = num
          }
        }
        break

      case 'A01':
        // 座標レコード
        if (parts.length >= 5) {
          const index = parseInt(parts[1]?.trim() || '0')
          const pointNumber = parts[2]?.trim() || `P${index}`
          const x = parseFloat(parts[3]?.trim() || '0')
          const y = parseFloat(parts[4]?.trim() || '0')
          const zStr = parts[5]?.trim()
          const z = zStr ? parseFloat(zStr) : null

          if (!isNaN(x) && !isNaN(y)) {
            coordinates.push({
              index,
              pointNumber,
              x,
              y,
              z: z !== null && !isNaN(z) ? z : null,
            })
          }
        }
        break
    }
  }

  return {
    coordinates,
    projectName,
    system,
  }
}

/**
 * Shift-JISエンコードされたArrayBufferをデコード
 */
export async function decodeShiftJIS(buffer: ArrayBuffer): Promise<string> {
  const decoder = new TextDecoder('shift-jis')
  return decoder.decode(buffer)
}

/**
 * ファイルからSIMAデータを読み込む
 */
export async function loadSimaFile(file: File): Promise<SimaParseResult> {
  const buffer = await file.arrayBuffer()

  // まずShift-JISとしてデコードを試みる
  let content: string
  try {
    content = await decodeShiftJIS(buffer)
  } catch {
    // 失敗した場合はUTF-8として読み込む
    content = await file.text()
  }

  return parseSima(content)
}
