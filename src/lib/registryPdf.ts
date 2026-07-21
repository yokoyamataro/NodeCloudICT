// 登記情報 PDF (touki.or.jp から取得 or ユーザーが手動アップロード) を、
// Supabase Edge Function `parse-registry-pdf` 経由で Claude Haiku に投げて
// 構造化 JSON として抽出する。
//
// 以前は pdfjs でテキスト抽出 → 正規表現で頑張ってパースしていたが、全部事項
// は相続 / 売買 / 共有 / 会社所有 / 分筆・合筆履歴等でレイアウトが千差万別で
// 正規表現の保守が破綻したため、AI に一本化した。

import { supabase } from '@/lib/supabase'

export interface ParsedOwner {
  address: string
  fullName: string
  /** 共有持分 (例: "1/2") — 単有なら null */
  share?: string | null
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
  /** 現在の所有者（複数可。共有なら全員含む） */
  owners: ParsedOwner[]
  /** AI 抽出時の信頼度 0.0-1.0 */
  confidence: number
  /** 警告 / 抽出時の注記 */
  warnings: string[]
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

// File → base64 string (data URL prefix なし)
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  // 大きめ (~200KB) の Uint8Array を一度に btoa に渡すと failure するので chunk
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)),
    )
  }
  return btoa(bin)
}

interface AiExtracted {
  location: string | null
  parcel_number: string | null
  land_category: string | null
  area_sqm: number | null
  owners: Array<{ name: string; address: string; share?: string | null }>
  confidence: number
  warnings: string[]
}

/** Supabase Edge Function `parse-registry-pdf` を叩いて PDF を AI にパースさせる。 */
export async function parseRegistryPdfViaAI(
  file: File,
  kind: 'ownership' | 'full',
  hint?: { location?: string | null; parcel_number?: string | null },
): Promise<ParsedRegistry> {
  const pdfBase64 = await fileToBase64(file)
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean
    extracted?: AiExtracted
    error?: string
  }>('parse-registry-pdf', {
    body: {
      pdf_base64: pdfBase64,
      kind,
      hint: hint
        ? { ...hint, file_name: file.name }
        : { file_name: file.name },
    },
  })
  if (error) {
    // Supabase Functions が返す FunctionsHttpError から body を取り出す
    let detail = error.message
    try {
      const ctx = (error as { context?: Response }).context
      if (ctx) {
        const body = await ctx.json()
        if (body?.error) detail = body.error
      }
    } catch {
      /* ignore */
    }
    throw new Error(`parse_edge_function_error: ${detail}`)
  }
  if (!data?.ok || !data.extracted) {
    throw new Error(data?.error ?? 'parse_no_extracted')
  }
  const ex = data.extracted
  const owners: ParsedOwner[] = ex.owners.map((o) => ({
    address: o.address,
    fullName: o.name,
    share: o.share ?? null,
  }))
  return {
    fileName: file.name,
    location: ex.location,
    parcelNumber: ex.parcel_number
      ? normalizeParcelNumber(ex.parcel_number)
      : null,
    landCategory: ex.land_category,
    areaSqm: ex.area_sqm,
    owners,
    confidence: ex.confidence,
    warnings: ex.warnings,
  }
}
