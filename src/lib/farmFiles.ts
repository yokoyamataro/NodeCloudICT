// 工区ごとの ファイルストレージ。
//
// メタデータ: public.farm_files / 実体: storage バケット 'farm-files'
// 制限は 1 工区 20MB、アップロードから 3 ヶ月。どちらも DB 側でも 効かせて
// あるので、ここでの 判定は 「押す前に 分かる」ための もの。
//
// 扱う 種類: PDF / SFC / P21 / DXF / LandXML / SIM
//   SFC / P21 は 保存と 受け渡しのみ (画面での 閲覧は 未実装)。

import { supabase } from './supabase'

/**
 * Supabase の エラーは Error を 継承していない ただの オブジェクト なので、
 * String() すると "[object Object]" に なる。message / hint を 拾って 出す。
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error_description?: unknown; hint?: unknown; details?: unknown }
    const parts = [o.message, o.error_description, o.details, o.hint]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' / ')
    try {
      return JSON.stringify(e)
    } catch {
      return '不明なエラー'
    }
  }
  return String(e)
}

const BUCKET = 'farm-files'

/** 1 工区あたりの 上限 [バイト]。DB の トリガと 同じ 値に する */
export const FARM_FILE_QUOTA_BYTES = 20 * 1024 * 1024

export type FarmFileKind = 'pdf' | 'sfc' | 'p21' | 'dxf' | 'landxml' | 'sim'

/** 拡張子 → 種別。対応外は null */
export function kindFromFileName(name: string): FarmFileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf':
      return 'pdf'
    case 'sfc':
      return 'sfc'
    case 'p21':
      return 'p21'
    case 'dxf':
      return 'dxf'
    case 'xml':
    case 'landxml':
      return 'landxml'
    case 'sim':
      return 'sim'
    default:
      return null
  }
}

export const FARM_FILE_KIND_LABEL: Record<FarmFileKind, string> = {
  pdf: 'PDF',
  sfc: 'SFC',
  p21: 'P21',
  dxf: 'DXF',
  landxml: 'LandXML',
  sim: 'SIMA',
}

/** 画面で 中身を 見られる 種別か (SFC / P21 は 未実装) */
export function canPreview(kind: FarmFileKind): boolean {
  return kind === 'pdf' || kind === 'dxf' || kind === 'landxml' || kind === 'sim'
}

/** ファイル選択ダイアログ用の accept 文字列 */
export const FARM_FILE_ACCEPT =
  '.pdf,.sfc,.p21,.dxf,.xml,.landxml,.sim,.PDF,.SFC,.P21,.DXF,.XML,.LANDXML,.SIM'

export interface FarmFileRow {
  id: string
  farmId: string
  name: string
  storagePath: string
  sizeBytes: number
  kind: FarmFileKind
  notes: string | null
  /** この 時刻を 過ぎた ものは 一覧に 出さない */
  expiresAt: string
  createdBy: string | null
  createdAt: string
}

interface DbRow {
  id: string
  farm_id: string
  name: string
  storage_path: string
  size_bytes: number
  kind: string
  notes: string | null
  expires_at: string
  created_by: string | null
  created_at: string
}

function toRow(d: DbRow): FarmFileRow {
  return {
    id: d.id,
    farmId: d.farm_id,
    name: d.name,
    storagePath: d.storage_path,
    sizeBytes: Number(d.size_bytes ?? 0),
    kind: d.kind as FarmFileKind,
    notes: d.notes,
    expiresAt: d.expires_at,
    createdBy: d.created_by,
    createdAt: d.created_at,
  }
}

/** 期限内の ファイルを 新しい順に 返す */
export async function listFarmFiles(farmId: string): Promise<FarmFileRow[]> {
  const { data, error } = await supabase
    .from('farm_files')
    .select('*')
    .eq('farm_id', farmId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as unknown as DbRow[]).map(toRow)
}

/** 期限内の 合計サイズ [バイト] */
export function usedBytes(rows: FarmFileRow[]): number {
  return rows.reduce((sum, r) => sum + r.sizeBytes, 0)
}

/**
 * アップロード。
 * 容量は DB の トリガでも 見ているが、実体を 上げてから 弾かれると
 * ゴミが 残るので、メタデータを 先に 入れて 通ってから 実体を 上げる。
 */
export async function uploadFarmFile(args: {
  farmId: string
  file: File
  notes?: string | null
}): Promise<FarmFileRow> {
  const kind = kindFromFileName(args.file.name)
  if (!kind) {
    throw new Error(
      '対応していない形式です (PDF / SFC / P21 / DXF / LandXML / SIM)',
    )
  }
  const ext = args.file.name.toLowerCase().split('.').pop() ?? 'bin'
  const uid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const storagePath = `${args.farmId}/${uid}.${ext}`

  // 1) メタデータ (容量トリガが ここで 効く)
  const { data, error } = await supabase
    .from('farm_files')
    .insert({
      farm_id: args.farmId,
      name: args.file.name,
      storage_path: storagePath,
      size_bytes: args.file.size,
      kind,
      notes: args.notes ?? null,
    } as never)
    .select('*')
    .single()
  if (error) throw error

  // 2) 実体。失敗したら メタデータを 巻き戻す
  const up = await supabase.storage.from(BUCKET).upload(storagePath, args.file, {
    upsert: false,
    contentType: args.file.type || undefined,
  })
  if (up.error) {
    await supabase.from('farm_files').delete().eq('id', (data as unknown as DbRow).id)
    throw up.error
  }
  return toRow(data as unknown as DbRow)
}

/** ダウンロード / 閲覧用の 一時 URL (既定 1 時間) */
export async function getFarmFileUrl(storagePath: string, expiresInSec = 3600): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSec)
  if (error) throw error
  if (!data?.signedUrl) throw new Error('URL の発行に失敗しました')
  return data.signedUrl
}

/** 中身を バイト列で 取る (DXF は Shift-JIS が 多く、文字コードを 自前で 判定する) */
export async function downloadFarmFileBytes(storagePath: string): Promise<ArrayBuffer> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)
  if (error) throw error
  if (!data) throw new Error('ダウンロードに失敗しました')
  return await data.arrayBuffer()
}

/** 中身を テキストで 取る (DXF / LandXML / SIM の 閲覧用) */
export async function downloadFarmFileText(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)
  if (error) throw error
  if (!data) throw new Error('ダウンロードに失敗しました')
  return await data.text()
}

/** 実体と メタデータを 消す */
export async function deleteFarmFile(row: FarmFileRow): Promise<void> {
  const { error: se } = await supabase.storage.from(BUCKET).remove([row.storagePath])
  if (se) throw se
  const { error } = await supabase.from('farm_files').delete().eq('id', row.id)
  if (error) throw error
}
