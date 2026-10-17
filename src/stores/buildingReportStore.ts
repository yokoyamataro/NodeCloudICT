// 建物調査報告書 (building_reports) の Zustand ストア。
//
// 構造 は 土地調査報告書 (landReportStore) と ほぼ 同じ。
// body は jsonb で 全セクション を 保持 する。
// 採番 は 作成者 (created_by) ス コープ の YY00001 連番 を 使う。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// ============================================================
// body の 型
// ============================================================

/** 01 登記の目的 の 1 申請行 */
export interface BuildingPurposeRow {
  appNo: number
  /** 変更/更正 (両方選択可) */
  changeType: { change: boolean; correction: boolean }
  /** 事件名 の チェック 項目 */
  events: {
    title: boolean           // 表題
    loss: boolean            // 滅失
    titleSection: boolean    // 表題部 (所在・種類・構造・床面積・附属建物)
    split: boolean           // 分割
    merge: boolean           // 合併
    combine: boolean         // 合体
    floorPlanCorrection: boolean      // 建物図面訂正
    eachFloorPlanCorrection: boolean  // 各階平面図訂正
    other: boolean
    otherText: string
  }
}

/** 02 調査した建物 の 1 行 */
export interface BuildingTargetRow {
  appNo: number
  /** 所在地番 (= 地番 + 所在 の 連結文字列、 編集 時 は そのまま) */
  location: string
  /** 家屋番号 */
  houseNumber: string
  /** 主附 の 別 及び 符号 (主 / 附属 1 / 附属 2 等) */
  mainSubType: string
  /** 種類 (居宅 / 共同住宅 等) */
  kind: string
  /** 構造 (木造 … 平家建 等) */
  structure: string
  /** 床面積 (㎡) */
  floorArea: number | null
  /** 第三者 の 権利 の 有無 (true=有 / false=無 / null=未) */
  thirdPartyRight: boolean | null
  /** 敷地 の 利用権限 (自己所有地 / 借地 等 の 自由 記述) */
  siteRight: string
}

/** 03 所有権登記名義人等 の 1 行 */
export interface BuildingOwnerRow {
  appNo: number
  /** 住所 (登記記録と異なる場合) */
  address: string
  name: string
  idMethod: 'license' | 'idcard' | 'meishiki' | 'other' | null
  idMethodOther: string
  /** 持分 (single=単有 / joint=共有) */
  ownership: 'single' | 'joint' | null
  /** 持分 の 分数表記 (例: '10分の9') */
  ownershipShare: string
  /** 連絡先 (電話番号 等) */
  contact: string
  /** 地権者管理 (landowners) の id (紐付け 済み の 時 のみ) */
  landownerId: string | null
}

/** 04 登記原因及びその日付 の 1 行 */
export interface BuildingCauseRow {
  appNo: number
  causeDate: string   // ISO date
  cause: string       // 新築 / 増築 / 取壊 / 合体 等
  reason: string      // 判断理由 (自由 文)
}

/** 05 資料 の 1 行。 group で 「登記所資料 / 官公署等資料 / その他」 を 分ける */
export interface BuildingMaterialRow {
  id: string
  group: 'registry' | 'public' | 'other'
  /** 資料等番号 (1,2,3 … 空 なら 連番表示 無し) */
  no: string
  /** 資料名 (登記記録 / 建築確認済証 等) */
  name: string
  /** ■ (true) か □ (false) */
  checked: boolean
}

/** 06 資料・証言・事実等 の 分析 の 1 行 */
export interface BuildingAnalysisRow {
  appNo: number
  materialRange: string   // 資料等番号 (例: '1-3')
  item: string            // 調査項目 (例: '●敷地の権利、形状に関する事項')
  result: string          // 調査結果 及び 報告事項
}

/** 07 現地の状況 — 敷地内 の 状況 (申請番号ごと) */
export interface BuildingSiteStatusRow {
  appNo: number
  unregisteredExists: boolean | null  // 未登記建物: 有 / 無
  registeredExists: boolean | null    // 既登記建物: 有 / 無
  kindStructureOwner: string          // 種類・構造・所有者等 (自由 文)
  notes: string                       // 注意点・問題点 等
}

/** 07 現地の状況 — 建物 の 認定 (申請番号ごと) */
export interface BuildingAttestationRow {
  appNo: number
  surveyStart: string         // 調査期間 開始
  surveyEnd: string           // 〃 終了
  mainSubType: string         // 主附 の 別 及び 符号
  /** 附属建物 の 利用状況 / 位置 / 意思確認 */
  annex: { usage: string; location: string; consent: string }
  /** 建物 の 認定 */
  attestation: {
    fixation: boolean | null       // 定着性
    airSeparation: boolean | null  // 外気分断性
    usability: boolean | null      // 用途性・人貨滞留性
    tradability: boolean | null    // 取引性
    completion: 'completed' | 'in_progress' | null  // 完成度
    notes: string
  }
}

/** 07 現地の状況 — 建物 の 状況 (詳細) */
export interface BuildingDetailRow {
  appNo: number
  /** 構造 */
  structure: {
    kind: string          // 種類 (例: 居宅 100%)
    material: string      // 構成材料 (木造 等)
    roof: string          // 屋根 の 種類 (ソーラーパネルふき 等)
    floors: string        // 階数 (平家建 / 2 階建 等)
  }
  /** 床面積 の 算定 — 項目 ごと に 有無 + 算入 可否 + メモ */
  floorArea: {
    atrium: FloorAreaEntry        // 吹抜
    bayWindow: FloorAreaEntry     // 出窓
    stairs: FloorAreaEntry        // 階段室
    piloti: FloorAreaEntry        // ピロティ
    veranda: FloorAreaEntry       // ベランダ等
    loft: FloorAreaEntry          // ロフト
    atticSpace: FloorAreaEntry    // 小屋裏
    underFloor: FloorAreaEntry    // 床下収納
    otherSpecial: FloorAreaEntry  // 特殊階 その他
    other: FloorAreaEntry         // その他
  }
}

/** 床面積 判定 の 1 要素 */
export interface FloorAreaEntry {
  exists: boolean | null       // 有 / 無
  counted: boolean | null      // 床面積 に 算入 / 不算入
  note: string                 // 条件 や 自由 メモ
}

/** 07 現地の状況 — 写真 1 枚 */
export interface BuildingPhoto {
  id: string
  caption: string            // 撮影 方向 の 説明 (例: 西から東に向かって撮影)
  dataUrl: string            // base64 (storage に 後日 移す 想定)
  takenOn: string            // ISO date
  remark: string
}

/** 報告書 body 全体 */
export interface BuildingReportBody {
  meta: {
    reportDate: string          // ISO date
    reportNo: string
    surveyorId: string | null   // organization_surveyors.id
  }
  purposes: BuildingPurposeRow[]
  targets: BuildingTargetRow[]
  owners: BuildingOwnerRow[]
  causes: BuildingCauseRow[]
  materials: BuildingMaterialRow[]
  originalConfirmNote: string            // 05 下 の 原本結果確認 (自由 文)
  analyses: BuildingAnalysisRow[]
  siteStatuses: BuildingSiteStatusRow[]
  attestations: BuildingAttestationRow[]
  details: BuildingDetailRow[]
  photos: BuildingPhoto[]
  remark: string                         // 08
}

const emptyFloorEntry = (): FloorAreaEntry => ({
  exists: null,
  counted: null,
  note: '',
})

export const DEFAULT_BUILDING_REPORT_BODY: BuildingReportBody = {
  meta: { reportDate: '', reportNo: '', surveyorId: null },
  purposes: [],
  targets: [],
  owners: [],
  causes: [],
  materials: defaultMaterials(),
  originalConfirmNote:
    '電磁的記録（PDF）で添付した添付情報については原本の写しに相違ない。',
  analyses: [],
  siteStatuses: [],
  attestations: [],
  details: [],
  photos: [],
  remark:
    '添付した電磁的記録については、当職において添付情報が記載された書面を確認した上で、当該書面をスキャナにより読み取って作成した電磁的記録である。',
}

/** 05 資料 の 既定行 (建物 向け)。 サンプル PDF の 並び に 合わせる */
export function defaultMaterials(): BuildingMaterialRow[] {
  let seq = 0
  const id = () => `m${(seq += 1)}`
  return [
    // 登記所資料
    { id: id(), group: 'registry', no: '1', name: '土地登記記録', checked: false },
    { id: id(), group: 'registry', no: '',  name: '土地閉鎖登記記録・閉鎖登記簿', checked: false },
    { id: id(), group: 'registry', no: '',  name: '建物登記記録', checked: false },
    { id: id(), group: 'registry', no: '',  name: '建物閉鎖登記記録・閉鎖登記簿', checked: false },
    { id: id(), group: 'registry', no: '2', name: '地図', checked: false },
    { id: id(), group: 'registry', no: '',  name: '地図に準ずる図面', checked: false },
    { id: id(), group: 'registry', no: '',  name: '閉鎖地図及び閉鎖地図に準ずる図面', checked: false },
    { id: id(), group: 'registry', no: '3', name: '地積測量図・土地所在図', checked: false },
    { id: id(), group: 'registry', no: '',  name: '建物図面・各階平面図', checked: false },
    { id: id(), group: 'registry', no: '',  name: '旧土地台帳', checked: false },
    { id: id(), group: 'registry', no: '',  name: '旧土地台帳附属地図（和紙公図）', checked: false },
    { id: id(), group: 'registry', no: '',  name: 'その他', checked: false },
    // 官公署等資料
    { id: id(), group: 'public',   no: '4', name: '建築確認済証', checked: false },
    { id: id(), group: 'public',   no: '',  name: '建築計画概要書', checked: false },
    { id: id(), group: 'public',   no: '5', name: '検査済証', checked: false },
    { id: id(), group: 'public',   no: '',  name: '固定資産税課台帳登録事項証明書', checked: false },
    { id: id(), group: 'public',   no: '',  name: '固定資産税納付証明書', checked: false },
    { id: id(), group: 'public',   no: '',  name: '家屋滅失証明書', checked: false },
    { id: id(), group: 'public',   no: '',  name: '市町村役場の証明書', checked: false },
    { id: id(), group: 'public',   no: '',  name: 'その他', checked: false },
    // その他 の 事実等
    { id: id(), group: 'other',    no: '6', name: '工事完了引渡証明書等', checked: false },
    { id: id(), group: 'other',    no: '7', name: '建築請負契約書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '領収書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '敷地所有者の証明書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '譲渡証明書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '相続証明書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '持分確認書', checked: false },
    { id: id(), group: 'other',    no: '',  name: '下請工事', checked: false },
    { id: id(), group: 'other',    no: '',  name: '付帯工事', checked: false },
    { id: id(), group: 'other',    no: '',  name: '取壊証明書', checked: false },
    { id: id(), group: 'other',    no: '',  name: 'その他', checked: false },
  ]
}

export function defaultDetailRow(appNo: number): BuildingDetailRow {
  return {
    appNo,
    structure: { kind: '', material: '', roof: '', floors: '' },
    floorArea: {
      atrium: emptyFloorEntry(),
      bayWindow: emptyFloorEntry(),
      stairs: emptyFloorEntry(),
      piloti: emptyFloorEntry(),
      veranda: emptyFloorEntry(),
      loft: emptyFloorEntry(),
      atticSpace: emptyFloorEntry(),
      underFloor: emptyFloorEntry(),
      otherSpecial: emptyFloorEntry(),
      other: emptyFloorEntry(),
    },
  }
}

export interface BuildingReport {
  id: string
  farmId: string
  title: string
  body: BuildingReportBody
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  farm_id: string
  title: string
  body: unknown
  created_at: string
  updated_at: string
}

const toReport = (r: Row): BuildingReport => ({
  id: r.id,
  farmId: r.farm_id,
  title: r.title,
  body: {
    ...DEFAULT_BUILDING_REPORT_BODY,
    ...(r.body as Partial<BuildingReportBody>),
  },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface State {
  byFarm: Map<string, BuildingReport[]>
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string) => Promise<void>
  createReport: (farmId: string, title?: string) => Promise<BuildingReport | null>
  updateReport: (
    id: string,
    patch: Partial<Pick<BuildingReport, 'title' | 'body'>>,
  ) => Promise<void>
  deleteReport: (id: string) => Promise<void>
}

export const useBuildingReportStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loading: false,
  error: null,

  fetchByFarm: async (farmId) => {
    set({ loading: true, error: null })
    const { data, error } = await supabase
      .from('building_reports')
      .select('*')
      .eq('farm_id', farmId)
      .order('updated_at', { ascending: false })
    if (error) {
      set({ loading: false, error: error.message })
      return
    }
    const reports = ((data ?? []) as Row[]).map(toReport)
    const next = new Map(get().byFarm)
    next.set(farmId, reports)
    set({ byFarm: next, loading: false })
  },

  createReport: async (farmId, title = '無題の建物調査報告書') => {
    const { data: userRes } = await supabase.auth.getUser()
    const uid = userRes.user?.id ?? null

    // 採番: 自分 が 作った building_reports の reportNo 連番 (土地 と 同じ 方式)
    let reportNo = ''
    try {
      const query = supabase.from('building_reports').select('body')
      const { data: existing } = uid
        ? await query.eq('created_by', uid)
        : { data: [] as { body: unknown }[] }
      const nums: { num: number; digits: number }[] = []
      for (const row of (existing ?? []) as { body: unknown }[]) {
        const b = row.body as { meta?: { reportNo?: unknown } } | null
        const raw = b?.meta?.reportNo
        if (typeof raw !== 'string') continue
        const trimmed = raw.trim()
        if (!/^\d+$/.test(trimmed)) continue
        nums.push({ num: parseInt(trimmed, 10), digits: trimmed.length })
      }
      if (nums.length === 0) {
        const yy = String(new Date().getFullYear()).slice(-2)
        reportNo = `${yy}00001`
      } else {
        const maxEntry = nums.reduce((a, b) => (b.num > a.num ? b : a), nums[0])
        reportNo = String(maxEntry.num + 1).padStart(maxEntry.digits, '0')
      }
    } catch {
      /* 採番 失敗 して も 続行 */
    }

    const initialBody: BuildingReportBody = {
      ...DEFAULT_BUILDING_REPORT_BODY,
      meta: { ...DEFAULT_BUILDING_REPORT_BODY.meta, reportNo },
    }
    const payload = {
      farm_id: farmId,
      title,
      body: initialBody as unknown as Record<string, unknown>,
      created_by: uid,
    }
    const { data, error } = await supabase
      .from('building_reports')
      .insert(payload as never)
      .select('*')
      .single()
    if (error) {
      set({ error: error.message })
      return null
    }
    const created = toReport(data as Row)
    const next = new Map(get().byFarm)
    next.set(farmId, [created, ...(next.get(farmId) ?? [])])
    set({ byFarm: next })
    return created
  },

  updateReport: async (id, patch) => {
    const dbPatch: Record<string, unknown> = {}
    if (patch.title !== undefined) dbPatch.title = patch.title
    if (patch.body !== undefined) dbPatch.body = patch.body as unknown
    if (Object.keys(dbPatch).length === 0) return
    const { error } = await supabase
      .from('building_reports')
      .update(dbPatch as never)
      .eq('id', id)
    if (error) {
      set({ error: error.message })
      return
    }
    const next = new Map(get().byFarm)
    for (const [farmId, list] of next) {
      const idx = list.findIndex((r) => r.id === id)
      if (idx >= 0) {
        const updated = {
          ...list[idx],
          ...patch,
          updatedAt: new Date().toISOString(),
        } as BuildingReport
        const newList = [...list]
        newList[idx] = updated
        next.set(farmId, newList)
      }
    }
    set({ byFarm: next })
  },

  deleteReport: async (id) => {
    const { error } = await supabase.from('building_reports').delete().eq('id', id)
    if (error) {
      set({ error: error.message })
      return
    }
    const next = new Map(get().byFarm)
    for (const [farmId, list] of next) {
      next.set(farmId, list.filter((r) => r.id !== id))
    }
    set({ byFarm: next })
  },
}))
