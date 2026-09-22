// 登記 CSV (法務局 4600 形式) を 既存 の 境界測量 データモデル
// (design_work_areas + parcels + parcel_locations 等) に 取り込む。
//
// 統合方針 (2026-09-23):
//   ・法務局備付地図作成作業 の 独立 テーブル (registry_*) は 廃止 し、
//     全て parcels の 拡張 と 子 テーブル で 表現 する。
//   ・1 現場 = 1 farm 前提。 project 単位 の 統合 は 行わない。
//   ・CSV 由来 の parcel は 空 の design_work_areas (point_ids=[]) を
//     セット で 作成 し、後 で SIM 等 で 座標 を 埋める 想定。
//   ・地権者 の 自動生成 は しない。 地権者管理 側 の 「地番から読込」
//     で 手動 トリガ する。
//
// 注意:
//   ・design_work_areas を INSERT する と、後付け トリガ で parcels 行 が
//     自動作成 される (parcel_number = wa.name)。 CSV 側 の 追加 メタ
//     (registration_kind, registry_seq, ...) は UPSERT で 上書き する。
//   ・registered_land_category は 23 地目 の CHECK 制約 が あり、それ 以外
//     の 値 は NULL に フォールバック する。

import { supabase } from './supabase'
import type { RegistryRecord } from './registryCsv'

export interface ParcelImportProgress {
  phase: string
  done: number
  total: number
}

const CHUNK = 300

// 不動産登記規則 第99条 の 23 地目 (parcels CHECK 制約 と 一致)
const VALID_LAND_CATEGORIES = new Set<string>([
  '田', '畑', '宅地', '学校用地', '鉄道用地', '塩田', '鉱泉地', '池沼', '山林',
  '牧場', '原野', '墓地', '境内地', '運河用地', '水道用地', '用悪水路',
  'ため池', '堤', '井溝', '保安林', '公衆用道路', '公園', '雑種地',
])
function sanitizeLandCategory(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (!t) return null
  return VALID_LAND_CATEGORIES.has(t) ? t : null
}

// 型 未登録 の テーブル を 使う ため の キャスト。
const sb = supabase as unknown as {
  from: (t: string) => {
    select: (cols: string, opts?: { count?: 'exact'; head?: boolean }) => any
    insert: (rows: unknown) => any
    delete: () => any
    update: (row: unknown) => any
    upsert: (rows: unknown, opts?: { onConflict?: string }) => any
  }
}

// 「２３２・３２」 → 232.32
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

// 表示履歴 の 最新 の 非空 地目 / 地積 を 取り出す
function latestRegisteredMeta(r: RegistryRecord): {
  land_category: string | null
  area_sqm: number | null
} {
  let cat: string | null = null
  let area: number | null = null
  for (const d of r.displayHistories) {
    if (d.landCategory) cat = d.landCategory
    const a = parseAreaSqm(d.areaText)
    if (a != null) area = a
  }
  return { land_category: cat, area_sqm: area }
}

// 対象 farm 内 の CSV 由来 parcels の work_area_id を 収集。
async function fetchCsvParcelWorkAreaIds(farmId: string): Promise<string[]> {
  // step 1: farm 内 の 境界測量 work_areas を 取得
  const { data: was, error: e1 } = await sb
    .from('design_work_areas')
    .select('id')
    .eq('farm_id', farmId)
    .eq('work_type', 'boundary_survey')
  if (e1) throw e1
  const waIds = ((was ?? []) as Array<{ id: string }>).map((w) => w.id)
  if (waIds.length === 0) return []
  // step 2: それ ら の parcels で registry_seq が セット されて いる もの
  const out: string[] = []
  for (let i = 0; i < waIds.length; i += CHUNK) {
    const slice = waIds.slice(i, i + CHUNK)
    const { data, error: e2 } = await sb
      .from('parcels')
      .select('work_area_id')
      .in('work_area_id', slice)
      .not('registry_seq', 'is', null)
    if (e2) throw e2
    for (const row of (data ?? []) as Array<{ work_area_id: string }>) {
      out.push(row.work_area_id)
    }
  }
  return out
}

export async function hasFarmRegistryParcels(
  farmId: string,
): Promise<{ hasAny: boolean; count: number }> {
  const waIds = await fetchCsvParcelWorkAreaIds(farmId)
  return { hasAny: waIds.length > 0, count: waIds.length }
}

// farm 内 の 「CSV 由来」 parcels (+ 対応 design_work_areas + 子 履歴 行) を 削除。
export async function deleteFarmRegistryParcels(farmId: string): Promise<void> {
  const waIds = await fetchCsvParcelWorkAreaIds(farmId)
  if (waIds.length === 0) return
  // design_work_areas を 削除 する と CASCADE で parcels + 子 履歴 も 消える
  for (let i = 0; i < waIds.length; i += CHUNK) {
    const slice = waIds.slice(i, i + CHUNK)
    const { error } = await sb
      .from('design_work_areas')
      .delete()
      .in('id', slice)
    if (error) throw error
  }
}

// CSV 由来 レコード を farm に bulk 登録。
export async function importParcelsFromCsv(
  farmId: string,
  records: RegistryRecord[],
  onProgress?: (p: ParcelImportProgress) => void,
): Promise<{ inserted: number }> {
  if (records.length === 0) return { inserted: 0 }

  // 1) design_work_areas を bulk INSERT (name = 地番、point_ids=[])
  //    INSERT 時 に トリガ で parcels 行 が 自動作成 される (parcel_number = name)。
  onProgress?.({ phase: '画地を作成中', done: 0, total: records.length })
  const waInserts = records.map((r) => ({
    farm_id: farmId,
    work_type: 'boundary_survey',
    zone_number: r.property?.parcelNumber ?? String(r.seq),
    name: r.property?.parcelNumber ?? String(r.seq),
    point_ids: [] as string[],
    confirmed_point_ids: [] as string[],
    area_sqm: null,
    area_ha: null,
    perimeter_m: null,
    notes: null,
  }))

  const seqToWaId = new Map<number, string>()
  {
    let cursor = 0
    for (let i = 0; i < waInserts.length; i += CHUNK) {
      const slice = waInserts.slice(i, i + CHUNK)
      const { data, error } = await sb
        .from('design_work_areas')
        .insert(slice)
        .select('id')
      if (error) throw error
      const returned = (data ?? []) as Array<{ id: string }>
      for (const w of returned) {
        const rec = records[cursor++]
        if (rec) seqToWaId.set(rec.seq, w.id)
      }
      onProgress?.({
        phase: '画地を作成中',
        done: Math.min(i + CHUNK, waInserts.length),
        total: waInserts.length,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  // 2) parcels は トリガ で 既 に 作られて いる ので、CSV メタ を UPSERT で 上書き。
  //    work_area_id を 一意 キー に する。
  onProgress?.({ phase: '地番情報を反映中', done: 0, total: records.length })
  const parcelUpserts = records
    .filter((r) => seqToWaId.has(r.seq))
    .map((r) => {
      const meta = latestRegisteredMeta(r)
      return {
        work_area_id: seqToWaId.get(r.seq)!,
        parcel_number: r.property?.parcelNumber ?? '',
        location: r.property?.location ?? '',
        registered_land_category: sanitizeLandCategory(meta.land_category),
        registered_area_sqm: meta.area_sqm,
        registered_owner_name: r.ownerships[0]?.ownerName ?? null,
        registered_owner_address: r.ownerships[0]?.address ?? null,
        registration_kind: 'registered',
        registry_seq: r.seq,
        registry_kind: r.property?.kind ?? null,
        registry_status: r.property?.status ?? null,
        real_estate_number: r.property?.realEstateNumber ?? null,
      }
    })

  const waIdToParcelId = new Map<string, string>()
  for (let i = 0; i < parcelUpserts.length; i += CHUNK) {
    const slice = parcelUpserts.slice(i, i + CHUNK)
    const { data, error } = await sb
      .from('parcels')
      .upsert(slice, { onConflict: 'work_area_id' })
      .select('id, work_area_id')
    if (error) throw error
    const returned = (data ?? []) as Array<{ id: string; work_area_id: string }>
    for (const p of returned) waIdToParcelId.set(p.work_area_id, p.id)
    onProgress?.({
      phase: '地番情報を反映中',
      done: Math.min(i + CHUNK, parcelUpserts.length),
      total: parcelUpserts.length,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  // 3) 子 履歴 行 を 組み立て (parcel_id で 紐付け)
  const locRows: unknown[] = []
  const dhRows: unknown[] = []
  const owRows: unknown[] = []
  const kouRows: unknown[] = []
  const otoRows: unknown[] = []
  for (const r of records) {
    const waId = seqToWaId.get(r.seq)
    if (!waId) continue
    const pid = waIdToParcelId.get(waId)
    if (!pid) continue
    for (const l of r.locations) {
      locRows.push({
        parcel_id: pid,
        order_no: l.order,
        value: l.value,
        change_reason: l.changeReason || null,
        registered_at: l.registeredAt || null,
      })
    }
    for (const d of r.displayHistories) {
      dhRows.push({
        parcel_id: pid,
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
        parcel_id: pid,
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
        parcel_id: pid,
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
        parcel_id: pid,
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

  await insertMany('parcel_locations', locRows, '所在履歴を書き込み中')
  await insertMany('parcel_display_histories', dhRows, '表示履歴を書き込み中')
  await insertMany('parcel_ownerships', owRows, '所有権を書き込み中')
  await insertMany('parcel_kouku', kouRows, '甲区を書き込み中')
  await insertMany('parcel_otoku', otoRows, '乙区を書き込み中')

  return { inserted: records.length }
}
