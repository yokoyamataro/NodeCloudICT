// 登記 CSV パース結果 (RegistryRecord[]) を Supabase の 8 テーブル系に
// 保存 / 読込 する サービス。 project_id 単位。
//
// 今回 の 段階: CSV 原文 (物件本体 + 5 履歴表) の 保存 と 読込 のみ。
// project_owners / property_owner_shares の 名寄せ は 別段階 で 実装する。
//
// 型 は Database に 未登録 の ため 内部 で any キャスト を 使う。
// 呼び出し側 は 型付き の 引数 / 戻り値 だけ を 見ることになる。

import { supabase } from './supabase'
import type { RegistryRecord } from './registryCsv'

export interface SaveProgress {
  phase: string
  done: number
  total: number
}

const CHUNK = 500

// 型 未登録 の 新テーブル用 の エスケープハッチ。
// supabase-js は 型 で 絞り込む ため、Database に 無い テーブル 名 を
// そのまま 渡す と TS が 怒る。 実行時 は 単に PostgREST の エンドポイント
// なので、キャスト で 通しつつ runtime 挙動 は 標準クライアント と 同一。
const sb = supabase as unknown as {
  from: (t: string) => {
    select: (cols: string, opts?: { count?: 'exact'; head?: boolean }) => any
    insert: (rows: unknown) => any
    delete: () => any
    update: (row: unknown) => any
  }
}

// 「２３２・３２」 「232・32」 → 232.32
function parseAreaSqm(text: string): number | null {
  if (!text) return null
  const normalized = text
    .replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/[・･]/g, '.')
  const n = parseFloat(normalized)
  return Number.isFinite(n) ? n : null
}

export async function projectHasRegistryData(
  projectId: string,
): Promise<{ hasAny: boolean; count: number }> {
  const { count, error } = await sb
    .from('registry_properties')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
  if (error) throw error
  return { hasAny: (count ?? 0) > 0, count: count ?? 0 }
}

export async function deleteProjectRegistry(projectId: string): Promise<void> {
  // 子 テーブル は FK ON DELETE CASCADE で 自動 消去 される
  const { error } = await sb
    .from('registry_properties')
    .delete()
    .eq('project_id', projectId)
  if (error) throw error
}

interface PropInsert {
  project_id: string
  seq: number
  kind: string
  status: string
  location: string
  parcel_number: string
  real_estate_number: string
  initial_area_sqm: number | null
}

export async function saveRegistryCsv(
  projectId: string,
  records: RegistryRecord[],
  onProgress?: (p: SaveProgress) => void,
): Promise<{ inserted: number }> {
  if (records.length === 0) return { inserted: 0 }

  // 1) registry_properties を bulk INSERT。 initial_area_sqm は
  //    表示履歴 の 最新 非空 の 地積 から 推定 (登記時 の 地積)。
  const propInserts: PropInsert[] = records.map((r) => {
    const p = r.property
    let initialArea: number | null = null
    for (const d of r.displayHistories) {
      const a = parseAreaSqm(d.areaText)
      if (a != null) initialArea = a
    }
    return {
      project_id: projectId,
      seq: r.seq,
      kind: p?.kind ?? '',
      status: p?.status ?? '',
      location: p?.location ?? '',
      parcel_number: p?.parcelNumber ?? '',
      real_estate_number: p?.realEstateNumber ?? '',
      initial_area_sqm: initialArea,
    }
  })

  onProgress?.({
    phase: '物件を書き込み中',
    done: 0,
    total: propInserts.length,
  })

  const seqToId = new Map<number, string>()
  for (let i = 0; i < propInserts.length; i += CHUNK) {
    const slice = propInserts.slice(i, i + CHUNK)
    const { data, error } = await sb
      .from('registry_properties')
      .insert(slice)
      .select('id, seq')
    if (error) throw error
    for (const row of (data ?? []) as { id: string; seq: number }[]) {
      seqToId.set(row.seq, row.id)
    }
    onProgress?.({
      phase: '物件を書き込み中',
      done: Math.min(i + CHUNK, propInserts.length),
      total: propInserts.length,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  // 2) 子 テーブル 行 を メモリ で 組み立て
  const locRows: unknown[] = []
  const dhRows: unknown[] = []
  const owRows: unknown[] = []
  const kouRows: unknown[] = []
  const otoRows: unknown[] = []

  for (const r of records) {
    const pid = seqToId.get(r.seq)
    if (!pid) continue
    for (const l of r.locations) {
      locRows.push({
        property_id: pid,
        order_no: l.order,
        value: l.value,
        change_reason: l.changeReason || null,
        registered_at: l.registeredAt || null,
      })
    }
    for (const d of r.displayHistories) {
      dhRows.push({
        property_id: pid,
        order_no: d.order,
        parcel_number: d.parcelNumber,
        land_category: d.landCategory,
        area_text: d.areaText,
        reason: d.reason || null,
        cause_date: d.causeDate || null,
      })
    }
    for (const o of r.ownerships) {
      owRows.push({
        property_id: pid,
        order_no: o.order,
        address: o.address,
        share: o.share,
        owner_name: o.ownerName,
        extra: o.extra || null,
        received_at: o.receivedAt || null,
        receipt_number: o.receiptNumber || null,
      })
    }
    for (const k of r.kouku) {
      kouRows.push({
        property_id: pid,
        order_no: k.order,
        rank: k.rank,
        purpose: k.purpose,
        received_at: k.receivedAt || null,
        receipt_number: k.receiptNumber || null,
        detail: k.detail || null,
      })
    }
    for (const k of r.otoku) {
      otoRows.push({
        property_id: pid,
        order_no: k.order,
        rank: k.rank,
        purpose: k.purpose,
        received_at: k.receivedAt || null,
        receipt_number: k.receiptNumber || null,
        detail: k.detail || null,
      })
    }
  }

  const insertMany = async (
    table: string,
    rows: unknown[],
    label: string,
  ): Promise<void> => {
    if (rows.length === 0) return
    onProgress?.({ phase: label, done: 0, total: rows.length })
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      const { error } = await sb.from(table).insert(slice)
      if (error) throw error
      onProgress?.({
        phase: label,
        done: Math.min(i + CHUNK, rows.length),
        total: rows.length,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  await insertMany('registry_locations', locRows, '所在履歴を書き込み中')
  await insertMany('registry_display_histories', dhRows, '表示履歴を書き込み中')
  await insertMany('registry_ownerships', owRows, '所有権を書き込み中')
  await insertMany('registry_kouku', kouRows, '甲区を書き込み中')
  await insertMany('registry_otoku', otoRows, '乙区を書き込み中')

  return { inserted: records.length }
}

// project_id 配下 の 登記データ を まとめて 取得 し、
// メモリ 上 の RegistryRecord[] 形式 に 復元 する。
export async function loadRegistryFromDb(
  projectId: string,
  onProgress?: (p: SaveProgress) => void,
): Promise<RegistryRecord[]> {
  onProgress?.({ phase: '物件を取得中', done: 0, total: 0 })
  const { data: props, error } = await sb
    .from('registry_properties')
    .select('*')
    .eq('project_id', projectId)
    .order('seq', { ascending: true })
  if (error) throw error
  const propRows = (props ?? []) as Array<{
    id: string
    seq: number
    kind: string
    status: string
    location: string
    parcel_number: string
    real_estate_number: string
  }>
  if (propRows.length === 0) return []

  const idToRec = new Map<string, RegistryRecord>()
  for (const p of propRows) {
    idToRec.set(p.id, {
      seq: p.seq,
      property: {
        seq: p.seq,
        kind: p.kind,
        status: p.status,
        location: p.location,
        parcelNumber: p.parcel_number,
        realEstateNumber: p.real_estate_number,
        extra: '',
      },
      locations: [],
      displayHistories: [],
      ownerships: [],
      kouku: [],
      otoku: [],
    })
  }

  const ids = Array.from(idToRec.keys())

  const fetchChildren = async <T>(
    table: string,
    label: string,
  ): Promise<T[]> => {
    const all: T[] = []
    onProgress?.({ phase: label, done: 0, total: ids.length })
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const { data, error: err } = await sb
        .from(table)
        .select('*')
        .in('property_id', slice)
      if (err) throw err
      for (const row of (data ?? []) as T[]) all.push(row)
      onProgress?.({
        phase: label,
        done: Math.min(i + CHUNK, ids.length),
        total: ids.length,
      })
    }
    return all
  }

  const [locs, dhs, ows, kous, otos] = await Promise.all([
    fetchChildren<{
      property_id: string
      order_no: number
      value: string
      change_reason: string | null
      registered_at: string | null
    }>('registry_locations', '所在履歴を取得中'),
    fetchChildren<{
      property_id: string
      order_no: number
      parcel_number: string
      land_category: string
      area_text: string
      reason: string | null
      cause_date: string | null
    }>('registry_display_histories', '表示履歴を取得中'),
    fetchChildren<{
      property_id: string
      order_no: number
      address: string
      share: string
      owner_name: string
      extra: string | null
      received_at: string | null
      receipt_number: string | null
    }>('registry_ownerships', '所有権を取得中'),
    fetchChildren<{
      property_id: string
      order_no: number
      rank: string
      purpose: string
      received_at: string | null
      receipt_number: string | null
      detail: string | null
    }>('registry_kouku', '甲区を取得中'),
    fetchChildren<{
      property_id: string
      order_no: number
      rank: string
      purpose: string
      received_at: string | null
      receipt_number: string | null
      detail: string | null
    }>('registry_otoku', '乙区を取得中'),
  ])

  for (const l of locs) {
    const r = idToRec.get(l.property_id)
    if (!r) continue
    r.locations.push({
      order: l.order_no,
      value: l.value,
      changeReason: l.change_reason ?? '',
      registeredAt: l.registered_at ?? '',
    })
  }
  for (const d of dhs) {
    const r = idToRec.get(d.property_id)
    if (!r) continue
    r.displayHistories.push({
      order: d.order_no,
      parcelNumber: d.parcel_number,
      landCategory: d.land_category,
      areaText: d.area_text,
      reason: d.reason ?? '',
      causeDate: d.cause_date ?? '',
    })
  }
  for (const o of ows) {
    const r = idToRec.get(o.property_id)
    if (!r) continue
    r.ownerships.push({
      order: o.order_no,
      address: o.address,
      share: o.share,
      ownerName: o.owner_name,
      extra: o.extra ?? '',
      receivedAt: o.received_at ?? '',
      receiptNumber: o.receipt_number ?? '',
    })
  }
  for (const k of kous) {
    const r = idToRec.get(k.property_id)
    if (!r) continue
    r.kouku.push({
      order: k.order_no,
      rank: k.rank,
      purpose: k.purpose,
      receivedAt: k.received_at ?? '',
      receiptNumber: k.receipt_number ?? '',
      detail: k.detail ?? '',
    })
  }
  for (const k of otos) {
    const r = idToRec.get(k.property_id)
    if (!r) continue
    r.otoku.push({
      order: k.order_no,
      rank: k.rank,
      purpose: k.purpose,
      receivedAt: k.received_at ?? '',
      receiptNumber: k.receipt_number ?? '',
      detail: k.detail ?? '',
    })
  }

  for (const r of idToRec.values()) {
    r.locations.sort((a, b) => a.order - b.order)
    r.displayHistories.sort((a, b) => a.order - b.order)
    r.ownerships.sort((a, b) => a.order - b.order)
    r.kouku.sort((a, b) => a.order - b.order)
    r.otoku.sort((a, b) => a.order - b.order)
  }
  return Array.from(idToRec.values()).sort((a, b) => a.seq - b.seq)
}
