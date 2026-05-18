/**
 * SIMAフォーマットパーサー / エクスポート
 * 測量データ交換フォーマット（SIMA）を解析
 *
 * SIMA形式の座標レコード:
 * A01,番号,点名,X座標,Y座標,Z座標,
 */

import Encoding from 'encoding-japanese'

export interface SimaCoordinate {
  index: number
  pointNumber: string
  x: number
  y: number
  z: number | null
}

// 画地（ポリゴン）レコード: D00,{番号},{名称},{フラグ}, ... B01 でポイント参照 ... D99
export interface SimaPolygon {
  parcelNumber: string // D00 の番号（例: 463）
  parcelName: string   // D00 の名称（例: 1-2）
  pointNumbers: string[] // B01 で参照される点名のリスト（順序付き）
}

export interface SimaParseResult {
  coordinates: SimaCoordinate[]
  polygons: SimaPolygon[]
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
  const polygons: SimaPolygon[] = []
  let projectName: string | null = null
  let system: number | null = null
  let currentPolygon: SimaPolygon | null = null

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

      case 'D00':
        // 画地開始: D00,{番号},{名称},{フラグ},
        currentPolygon = {
          parcelNumber: parts[1]?.trim() || '',
          parcelName: parts[2]?.trim() || '',
          pointNumbers: [],
        }
        break

      case 'B01':
        // 画地内の点参照: B01,{index},{点名},
        if (currentPolygon) {
          const pn = parts[2]?.trim() || parts[1]?.trim() || ''
          if (pn) currentPolygon.pointNumbers.push(pn)
        }
        break

      case 'D99':
        // 画地終了
        if (currentPolygon && currentPolygon.pointNumbers.length > 0) {
          polygons.push(currentPolygon)
        }
        currentPolygon = null
        break

      // C03（距離・方向角）は B01 の補助情報なので無視（順序は B01 で確定）
    }
  }

  return {
    coordinates,
    polygons,
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

export interface SimaExportPoint {
  pointNumber: string
  x: number
  y: number
  z: number | null
}

export interface SimaExportPolygon {
  parcelNumber: string // 例: '463'
  parcelName: string   // 例: '1-2'
  pointNumbers: string[] // B01 で参照する点名のリスト（順序付き）
}

export interface SimaExportOptions {
  projectName: string
  zone: number // 平面直角座標系番号（1〜19）
  points: SimaExportPoint[]
  /** 画地（ポリゴン）データ。出力時のみ Z00 /* 画地データ * / セクションを追記 */
  polygons?: SimaExportPolygon[]
}

/**
 * SIMA形式の文字列を生成する
 * - 点名は20文字固定幅（左詰め、半角スペース埋め）
 * - 座標は10桁固定幅（小数点以下3桁、右詰め）
 * - インデックスは5桁右詰め
 */
export function buildSimaContent(opts: SimaExportOptions): string {
  const lines: string[] = []
  lines.push(`G00,04,${opts.projectName},`)
  lines.push('Z00, /* 座標データ */,')
  lines.push(`Z01,${opts.zone},`)
  lines.push('A00,')

  // 点名 → 1ベースの行番号（B01 参照用）
  const pointIndexByName = new Map<string, number>()
  opts.points.forEach((p, idx) => {
    const indexNum = idx + 1
    pointIndexByName.set(p.pointNumber, indexNum)
    const numStr = indexNum.toString().padStart(5, ' ')
    const paddedName = p.pointNumber.padEnd(20, ' ')
    const xStr = p.x.toFixed(3).padStart(10, ' ')
    const yStr = p.y.toFixed(3).padStart(10, ' ')
    const zStr = p.z !== null ? p.z.toFixed(3).padStart(10, ' ') : ''
    lines.push(`A01,${numStr},${paddedName},${xStr},${yStr},${zStr},`)
  })

  lines.push('A99,')

  // 画地データセクション
  if (opts.polygons && opts.polygons.length > 0) {
    lines.push('Z00, /* 画地データ */,')
    for (const poly of opts.polygons) {
      const numStr = poly.parcelNumber.toString().padStart(5, ' ')
      const nameStr = poly.parcelName.padEnd(10, ' ')
      lines.push(`D00,${numStr},${nameStr},1,`)
      for (const pn of poly.pointNumbers) {
        const idx = pointIndexByName.get(pn) ?? 0
        const idxStr = idx.toString().padStart(5, ' ')
        const paddedName = pn.padEnd(20, ' ')
        lines.push(`B01,${idxStr},${paddedName},`)
      }
      lines.push('D99,')
    }
  }

  return lines.join('\r\n') + '\r\n'
}

/**
 * Shift-JISエンコードしたBlobを返す
 */
export function encodeSimaShiftJIS(content: string): Blob {
  const unicodeArray = Encoding.stringToCode(content)
  const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' })
  const bytes = new Uint8Array(sjisArray)
  return new Blob([bytes.slice().buffer], { type: 'application/octet-stream' })
}

/**
 * SIMAファイルをダウンロードさせる
 */
export function downloadSimaFile(opts: SimaExportOptions, filename: string): void {
  const content = buildSimaContent(opts)
  const blob = encodeSimaShiftJIS(content)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
