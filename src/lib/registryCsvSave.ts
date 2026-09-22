// 登記 CSV パース結果 (RegistryRecord[]) を Supabase の 8 テーブル系に
// 保存 / 読込 する サービス。 project_id 単位。
//
// 実装 範囲:
//   ・CSV 原文 6 テーブル の bulk INSERT / 読込 (registry_*)
//   ・project_owners の 名寄せ + property_owner_shares の 生成
//     - 氏名 + 住所 完全一致 → 既存 owner に 自動 リンク
//     - 氏名 のみ 一致 (住所 違い) → 呼び出し側 の resolveConflicts コールバック
//       に 判定 を 委譲
//     - どちらも 一致 しない → 新規 owner を 作成
//
// 型 は Database に 未登録 の ため 内部 で any キャスト を 使う。

import { supabase } from './supabase'
import type { RegistryRecord } from './registryCsv'

export interface SaveProgress {
  phase: string
  done: number
  total: number
}

// (name, address) を キー に 使う。 null / undefined は 空文字列 に 正規化。
function ownerKey(name: string, address: string): string {
  return `${(name ?? '').trim()}${(address ?? '').trim()}`
}

// 名寄せ で 「氏名 のみ 一致」 の 確認 が 必要 な 塊
export interface OwnerConflict {
  // 一意 キー (name|address) — modal の 行 の key
  key: string
  csvName: string
  csvAddress: string
  // 既存 owner の 候補 (氏名 一致 / 住所 違い)
  candidates: Array<{ id: string; name: string; address: string }>
}

// ユーザー の 決定
export interface OwnerImportResolution {
  // conflict.key → 選択 id ('new' なら 新規 owner を 作る)
  decisions: Record<string, string | 'new'>
}

// 呼び出し側 は これ を async で 実装 (React の modal)。
// null 返却 = キャンセル (owner の 保存 を スキップ、6 テーブル は 保存 済み)。
export type OwnerConflictResolver = (
  conflicts: OwnerConflict[],
) => Promise<OwnerImportResolution | null>

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

// ============================================================
// 地権者 の 名寄せ + property_owner_shares 生成
// ============================================================

interface ExistingOwner {
  id: string
  name: string
  address: string
}

// DB 上 の registry_ownerships (× property_id) 行 を フラット に 取得。
// 「物件一覧 から 読込」 が 走る 時 の owner 情報 の 原本。
interface OwnershipRow {
  property_id: string
  order_no: number
  address: string
  share: string
  owner_name: string
}

async function fetchOwnershipsForProject(
  projectId: string,
): Promise<OwnershipRow[]> {
  // registry_properties.id で フィルタ (registry_ownerships には project_id が 無い)。
  // 先に property_id 一覧 を 取ってから ownerships を chunk 取得。
  const { data: props, error } = await sb
    .from('registry_properties')
    .select('id')
    .eq('project_id', projectId)
  if (error) throw error
  const ids = ((props ?? []) as Array<{ id: string }>).map((p) => p.id)
  if (ids.length === 0) return []

  const rows: OwnershipRow[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data, error: err } = await sb
      .from('registry_ownerships')
      .select('property_id, order_no, address, share, owner_name')
      .in('property_id', slice)
    if (err) throw err
    for (const r of (data ?? []) as OwnershipRow[]) rows.push(r)
  }
  return rows
}

async function fetchExistingOwners(projectId: string): Promise<ExistingOwner[]> {
  const { data, error } = await sb
    .from('project_owners')
    .select('id, name, address')
    .eq('project_id', projectId)
  if (error) throw error
  return ((data ?? []) as Array<{
    id: string
    name: string
    address: string | null
  }>).map((o) => ({
    id: o.id,
    name: o.name ?? '',
    address: o.address ?? '',
  }))
}

// CSV 側 の 一意 owner (name+address) を 集めて、既存 project_owners と 突合し、
// 「完全一致 (自動)」「氏名一致 (要確認)」「該当なし (新規)」 に 振り分ける。
export interface OwnerImportPlan {
  // 完全一致 で 既存 owner に 紐付く (name+address key → owner_id)
  exactMatches: Record<string, string>
  // 該当 owner が 0 件 (新規 作成 が 決定)
  newOwners: Array<{ name: string; address: string }>
  // 氏名 一致 だけ、住所 が 違う (ユーザー 判断 が 必要)
  conflicts: OwnerConflict[]
}

export async function planOwnerImport(
  projectId: string,
): Promise<OwnerImportPlan> {
  const ownerships = await fetchOwnershipsForProject(projectId)
  // registry_ownerships 内 の 一意 (name+address)
  const uniqCsv = new Map<string, { name: string; address: string }>()
  for (const o of ownerships) {
    const name = (o.owner_name ?? '').trim()
    const address = (o.address ?? '').trim()
    if (!name) continue
    const k = ownerKey(name, address)
    if (!uniqCsv.has(k)) uniqCsv.set(k, { name, address })
  }

  const existing = await fetchExistingOwners(projectId)
  const byExactKey = new Map<string, string>() // name+address → owner id
  const byName = new Map<string, ExistingOwner[]>()
  for (const o of existing) {
    byExactKey.set(ownerKey(o.name, o.address), o.id)
    const list = byName.get(o.name) ?? []
    list.push(o)
    byName.set(o.name, list)
  }

  const exactMatches: Record<string, string> = {}
  const newOwners: Array<{ name: string; address: string }> = []
  const conflicts: OwnerConflict[] = []

  for (const [key, cur] of uniqCsv.entries()) {
    const exact = byExactKey.get(key)
    if (exact) {
      exactMatches[key] = exact
      continue
    }
    const nameCandidates = byName.get(cur.name)
    if (nameCandidates && nameCandidates.length > 0) {
      conflicts.push({
        key,
        csvName: cur.name,
        csvAddress: cur.address,
        candidates: nameCandidates.map((c) => ({
          id: c.id,
          name: c.name,
          address: c.address,
        })),
      })
    } else {
      newOwners.push({ name: cur.name, address: cur.address })
    }
  }

  return { exactMatches, newOwners, conflicts }
}

// plan + resolution から 実際 に owner を 作成 し、property_owner_shares を 挿入 する。
// 参照 データ (registry_ownerships) は DB から 再取得 する。
export async function applyOwnerImport(
  projectId: string,
  plan: OwnerImportPlan,
  resolution: OwnerImportResolution,
  onProgress?: (p: SaveProgress) => void,
): Promise<{ ownersCreated: number; sharesCreated: number }> {
  // 1) 新規 owner を まとめて INSERT
  //    - plan.newOwners: 氏名 が 既存 に 無い もの
  //    - conflicts で decision='new' の もの
  const toCreate: Array<{ key: string; name: string; address: string }> = []
  for (const n of plan.newOwners) {
    toCreate.push({ key: ownerKey(n.name, n.address), name: n.name, address: n.address })
  }
  for (const c of plan.conflicts) {
    const dec = resolution.decisions[c.key]
    if (dec === 'new') {
      toCreate.push({ key: c.key, name: c.csvName, address: c.csvAddress })
    }
  }

  const keyToOwnerId: Record<string, string> = { ...plan.exactMatches }
  // conflicts の 既存 owner 選択 分
  for (const c of plan.conflicts) {
    const dec = resolution.decisions[c.key]
    if (dec && dec !== 'new') {
      keyToOwnerId[c.key] = dec
    }
  }

  let ownersCreated = 0
  if (toCreate.length > 0) {
    onProgress?.({
      phase: '地権者を作成中',
      done: 0,
      total: toCreate.length,
    })
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const slice = toCreate.slice(i, i + CHUNK)
      const rows = slice.map((s) => ({
        project_id: projectId,
        name: s.name,
        address: s.address || null,
      }))
      const { data, error } = await sb
        .from('project_owners')
        .insert(rows)
        .select('id, name, address')
      if (error) throw error
      const returned = (data ?? []) as Array<{
        id: string
        name: string
        address: string | null
      }>
      // 順序 が 保証 されない ので (name, address) で 突合 する
      const byKey = new Map<string, string>()
      for (const r of returned) {
        byKey.set(ownerKey(r.name, r.address ?? ''), r.id)
      }
      for (const s of slice) {
        const id = byKey.get(s.key)
        if (id) keyToOwnerId[s.key] = id
      }
      ownersCreated += slice.length
      onProgress?.({
        phase: '地権者を作成中',
        done: Math.min(i + CHUNK, toCreate.length),
        total: toCreate.length,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  // 2) property_owner_shares を bulk UPSERT
  //    (property_id, owner_id, share) は UNIQUE。 再実行 に 耐える よう
  //    ignoreDuplicates=true で 二重 挿入 を 防ぐ。
  const ownerships = await fetchOwnershipsForProject(projectId)
  const shareRows: Array<{
    property_id: string
    owner_id: string
    share: string
    order_no: number
  }> = []
  const skippedNoOwner: string[] = []
  for (const o of ownerships) {
    const name = (o.owner_name ?? '').trim()
    const address = (o.address ?? '').trim()
    if (!name) continue
    const ownerId = keyToOwnerId[ownerKey(name, address)]
    if (!ownerId) {
      skippedNoOwner.push(name)
      continue
    }
    shareRows.push({
      property_id: o.property_id,
      owner_id: ownerId,
      share: o.share ?? '',
      order_no: o.order_no,
    })
  }

  let sharesCreated = 0
  if (shareRows.length > 0) {
    onProgress?.({
      phase: '持分を書き込み中',
      done: 0,
      total: shareRows.length,
    })
    for (let i = 0; i < shareRows.length; i += CHUNK) {
      const slice = shareRows.slice(i, i + CHUNK)
      // ignoreDuplicates: 再実行 で UNIQUE 違反 に なった 行 は 静か に スキップ
      const { error } = await (sb.from(
        'property_owner_shares',
      ) as unknown as {
        upsert: (
          rows: unknown,
          opts: { onConflict: string; ignoreDuplicates: boolean },
        ) => Promise<{ error: { message: string } | null }>
      }).upsert(slice, {
        onConflict: 'property_id,owner_id,share',
        ignoreDuplicates: true,
      })
      if (error) throw error
      sharesCreated += slice.length
      onProgress?.({
        phase: '持分を書き込み中',
        done: Math.min(i + CHUNK, shareRows.length),
        total: shareRows.length,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  if (skippedNoOwner.length > 0) {
    console.warn('[registryCsvSave] shares skipped (no owner mapping)', {
      count: skippedNoOwner.length,
    })
  }
  return { ownersCreated, sharesCreated }
}

// ============================================================
// 地権者リスト の 読込 / 更新 (地権者リスト ページ 用)
// ============================================================

export interface RegistryOwnerRow {
  id: string
  name: string
  name_kana: string
  address: string
  phone: string
  agent_name: string
  agent_address: string
  agent_phone: string
  notes: string
  // 保持 する 地番 の 一覧 (property_number)
  parcels: Array<{
    share_id: string          // property_owner_shares.id (更新用)
    property_id: string
    parcel_number: string
    location: string
    share: string
    first_visit_at: string | null
    first_visit_status: string
    second_visit_at: string | null
    second_visit_status: string
    notes: string
  }>
}

export async function loadRegistryOwners(
  projectId: string,
): Promise<RegistryOwnerRow[]> {
  const { data: owners, error } = await sb
    .from('project_owners')
    .select(
      'id, name, name_kana, address, phone, agent_name, agent_address, agent_phone, notes',
    )
    .eq('project_id', projectId)
    .order('name_kana', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) throw error
  const ownerRows = (owners ?? []) as Array<{
    id: string
    name: string
    name_kana: string | null
    address: string | null
    phone: string | null
    agent_name: string | null
    agent_address: string | null
    agent_phone: string | null
    notes: string | null
  }>
  if (ownerRows.length === 0) return []

  const ownerIds = ownerRows.map((o) => o.id)

  // shares を まとめて 取得 + 参照先 property の 一部 列 も 引く
  const allShares: Array<{
    id: string
    owner_id: string
    property_id: string
    share: string
    first_visit_at: string | null
    first_visit_status: string | null
    second_visit_at: string | null
    second_visit_status: string | null
    notes: string | null
  }> = []
  for (let i = 0; i < ownerIds.length; i += CHUNK) {
    const slice = ownerIds.slice(i, i + CHUNK)
    const { data, error: err } = await sb
      .from('property_owner_shares')
      .select(
        'id, owner_id, property_id, share, first_visit_at, first_visit_status, second_visit_at, second_visit_status, notes',
      )
      .in('owner_id', slice)
    if (err) throw err
    for (const row of (data ?? []) as typeof allShares) allShares.push(row)
  }

  // property_id → (parcel_number, location) の マップ を 引く
  const propIds = Array.from(new Set(allShares.map((s) => s.property_id)))
  const propMeta = new Map<string, { parcel_number: string; location: string }>()
  for (let i = 0; i < propIds.length; i += CHUNK) {
    const slice = propIds.slice(i, i + CHUNK)
    const { data, error: err } = await sb
      .from('registry_properties')
      .select('id, parcel_number, location')
      .in('id', slice)
    if (err) throw err
    for (const p of (data ?? []) as Array<{
      id: string
      parcel_number: string
      location: string
    }>) {
      propMeta.set(p.id, { parcel_number: p.parcel_number, location: p.location })
    }
  }

  const byOwner = new Map<string, RegistryOwnerRow>()
  for (const o of ownerRows) {
    byOwner.set(o.id, {
      id: o.id,
      name: o.name ?? '',
      name_kana: o.name_kana ?? '',
      address: o.address ?? '',
      phone: o.phone ?? '',
      agent_name: o.agent_name ?? '',
      agent_address: o.agent_address ?? '',
      agent_phone: o.agent_phone ?? '',
      notes: o.notes ?? '',
      parcels: [],
    })
  }
  for (const s of allShares) {
    const or = byOwner.get(s.owner_id)
    if (!or) continue
    const meta = propMeta.get(s.property_id) ?? { parcel_number: '', location: '' }
    or.parcels.push({
      share_id: s.id,
      property_id: s.property_id,
      parcel_number: meta.parcel_number,
      location: meta.location,
      share: s.share ?? '',
      first_visit_at: s.first_visit_at,
      first_visit_status: s.first_visit_status ?? '',
      second_visit_at: s.second_visit_at,
      second_visit_status: s.second_visit_status ?? '',
      notes: s.notes ?? '',
    })
  }
  for (const or of byOwner.values()) {
    or.parcels.sort((a, b) => a.parcel_number.localeCompare(b.parcel_number, 'ja'))
  }
  return Array.from(byOwner.values())
}

export async function updateProjectOwner(
  ownerId: string,
  patch: Partial<{
    name: string
    name_kana: string | null
    address: string | null
    phone: string | null
    agent_name: string | null
    agent_address: string | null
    agent_phone: string | null
    notes: string | null
  }>,
): Promise<void> {
  const { error } = await sb.from('project_owners').update(patch).eq('id', ownerId)
  if (error) throw error
}

export async function updateOwnerShare(
  shareId: string,
  patch: Partial<{
    first_visit_at: string | null
    first_visit_status: string | null
    second_visit_at: string | null
    second_visit_status: string | null
    notes: string | null
  }>,
): Promise<void> {
  const { error } = await sb
    .from('property_owner_shares')
    .update(patch)
    .eq('id', shareId)
  if (error) throw error
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
