// fetch-registry-pdfs Edge Function 呼び出しラッパ。
// サイトオーナー限定の Phase 1 挙動 (Edge Function 側でも二重にチェック)。

import { supabase } from '@/lib/supabase'

export type RegistryKind = 'ownership' | 'full'

export interface RegistryFetchRequest {
  /** design_work_areas.id (parcel と 1:1) */
  work_area_id: string
  prefecture: string
  city: string
  location: string
  parcel_number: string
}

export interface RegistryFetchResult {
  work_area_id: string
  parcel_number: string
  kind: RegistryKind
  attachment_id: string | null
  signed_url: string | null
  error: string | null
}

export interface RegistryFetchResponse {
  ok: boolean
  results?: RegistryFetchResult[]
  /** サーバレベルの失敗 (資格情報未登録 / Fly.io 到達不能等) */
  error?: string
}

/**
 * 選択した地番について、touki.or.jp から証明書 PDF を取得し attachments に保管する。
 * Phase 1 はサイトオーナー限定 (Edge Function 側で is_site_owner() 検証)。
 */
export async function fetchRegistryPdfs(
  requests: RegistryFetchRequest[],
  kind: RegistryKind,
): Promise<RegistryFetchResponse> {
  if (requests.length === 0) {
    return { ok: false, error: 'requests is empty' }
  }
  const { data, error } = await supabase.functions.invoke<RegistryFetchResponse>(
    'fetch-registry-pdfs',
    { body: { requests, kind } },
  )
  if (error) {
    // Supabase の FunctionsHttpError は非 2xx の Response をラップしている。
    // 中の JSON エラー本文を取り出して詳細を返す (デバッグ性向上)。
    const anyErr = error as {
      message?: string
      context?: Response
    }
    let detail: string | undefined
    if (anyErr.context && typeof anyErr.context.text === 'function') {
      try {
        const text = await anyErr.context.text()
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string }
          detail = parsed.error ?? parsed.message ?? text
        } catch {
          detail = text
        }
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: detail ?? anyErr.message ?? String(error),
    }
  }
  if (!data) {
    return { ok: false, error: 'no response' }
  }
  return data
}
