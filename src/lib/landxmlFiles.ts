// 工区ごとの LandXML ファイルを Supabase Storage / メタデータテーブルで管理する。
//
// バケット: 'landxml'（プライベート）
// パス     : '<farmId>/<uuid>.xml'
// テーブル : public.landxml_files

import { supabase } from './supabase'

const BUCKET = 'landxml'

export type LandxmlKind = 'design' | 'trench' | 'ground' | string

export interface LandxmlFileRow {
  id: string
  farmId: string
  name: string
  storagePath: string
  sizeBytes: number | null
  kind: LandxmlKind
  isActive: boolean
  notes: string | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

interface DbRow {
  id: string
  farm_id: string
  name: string
  storage_path: string
  size_bytes: number | null
  kind: string
  is_active: boolean
  notes: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

const fromDb = (r: DbRow): LandxmlFileRow => ({
  id: r.id,
  farmId: r.farm_id,
  name: r.name,
  storagePath: r.storage_path,
  sizeBytes: r.size_bytes,
  kind: r.kind,
  isActive: r.is_active,
  notes: r.notes,
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** 工区の LandXML ファイル一覧（新しい順）。 */
export async function listLandxmlFiles(farmId: string): Promise<LandxmlFileRow[]> {
  const { data, error } = await supabase
    .from('landxml_files')
    .select('*')
    .eq('farm_id', farmId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data as DbRow[] | null)?.map(fromDb) ?? []
}

/** 工区 + kind の active なファイル（無ければ null）。 */
export async function getActiveLandxmlFile(
  farmId: string,
  kind: LandxmlKind = 'design',
): Promise<LandxmlFileRow | null> {
  const { data, error } = await supabase
    .from('landxml_files')
    .select('*')
    .eq('farm_id', farmId)
    .eq('kind', kind)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? fromDb(data as DbRow) : null
}

/** Storage からテキストとしてダウンロード。 */
export async function downloadLandxmlText(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)
  if (error) throw error
  if (!data) throw new Error('LandXMLのダウンロードに失敗しました')
  return await data.text()
}

/**
 * 新しい LandXML を Storage に保存し、メタデータを INSERT する。
 * 既存の同一 kind の active なファイルは is_active=false にする。
 */
export async function uploadLandxmlFile(args: {
  farmId: string
  fileName: string
  content: Blob | string
  kind?: LandxmlKind
  notes?: string | null
}): Promise<LandxmlFileRow> {
  const kind = args.kind ?? 'design'
  const ext = args.fileName.toLowerCase().endsWith('.xml') ? '' : '.xml'
  const uid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const storagePath = `${args.farmId}/${uid}${ext || '.xml'}`

  const body =
    typeof args.content === 'string'
      ? new Blob([args.content], { type: 'application/xml' })
      : args.content

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, body, {
    contentType: 'application/xml',
    upsert: false,
  })
  if (upErr) throw upErr

  // 旧 active を落とす（失敗しても続行）
  try {
    await supabase
      .from('landxml_files')
      .update({ is_active: false } as never)
      .eq('farm_id', args.farmId)
      .eq('kind', kind)
      .eq('is_active', true)
  } catch {
    /* ignore */
  }

  // メタ行を作成
  const { data, error } = await supabase
    .from('landxml_files')
    .insert({
      farm_id: args.farmId,
      name: args.fileName,
      storage_path: storagePath,
      size_bytes: body.size,
      kind,
      is_active: true,
      notes: args.notes ?? null,
    } as never)
    .select()
    .single()

  if (error) {
    // ロールバック: Storage に上げたファイルを消す
    try {
      await supabase.storage.from(BUCKET).remove([storagePath])
    } catch {
      /* ignore */
    }
    throw error
  }
  return fromDb(data as DbRow)
}

/** 履歴の任意のファイルを active にする（同一 kind の他は false に）。 */
export async function setActiveLandxmlFile(row: LandxmlFileRow): Promise<void> {
  // 旧 active を落とす
  await supabase
    .from('landxml_files')
    .update({ is_active: false } as never)
    .eq('farm_id', row.farmId)
    .eq('kind', row.kind)
    .eq('is_active', true)
  // 指定行を active に
  const { error } = await supabase
    .from('landxml_files')
    .update({ is_active: true } as never)
    .eq('id', row.id)
  if (error) throw error
}

/** 履歴 1 件を Storage + メタから完全削除する。 */
export async function deleteLandxmlFile(row: LandxmlFileRow): Promise<void> {
  await supabase.storage.from(BUCKET).remove([row.storagePath])
  const { error } = await supabase.from('landxml_files').delete().eq('id', row.id)
  if (error) throw error
}
