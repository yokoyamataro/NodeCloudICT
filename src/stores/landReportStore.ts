// 土地調査報告書 (land_reports) の Zustand ストア。
//
// テーブル: public.land_reports (farm_id FK)
//   body は jsonb で 全入力を保持。
//   RLS で「工区にアクセスできる プロジェクトメンバー」なら CRUD 可能。
//
// UI は 現 farm の 報告書一覧 → 選択して編集/削除 のフロー。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

// ============================================================
// body の型 (セクション別に部分的に詰めていく想定なので Partial ベース)
//
// Phase 1 では 全セクションのフィールドを 用意した状態で 初期化する。
// 個別の UI が未実装のセクションは 空値のまま Excel 出力される。
// ============================================================

/** 01 登記の目的 の 1 申請行 */
export interface ReportPurposeRow {
  appNo: number
  changeType: 'change' | 'correction' | null   // ■変更 / ■更正
  events: {
    title: boolean            // 表題
    subdivision: boolean      // 分筆
    merger: boolean           // 合筆
    location: boolean         // 所在
    landCategory: boolean     // 地目
    area: boolean             // 地積
    mapCorrection: boolean    // 地図訂正
    surveyMapCorrection: boolean       // 地積測量図訂正
    locationMapCorrection: boolean     // 土地所在図訂正
    other: boolean            // その他
    otherText: string
  }
}

/** 02 調査した土地 の 1 行 */
export interface ReportParcelRow {
  appNo: number
  parcelId: string | null       // parcels (地番管理) の id
  // スナップショット (parcels 側の変更に影響されない)
  location: string
  parcelNumber: string
  landCategory: string
  /** 実測面積 (m²) — parcels.updated_area_sqm から取り込み */
  areaSqm: number | null
  /** 登記面積 (m²) — parcels.registered_area_sqm から取り込み (09 甲差検証で使う) */
  registeredAreaSqm: number | null
  hasThirdPartyRight: boolean | null   // true=有, false=無, null=未選択
  usage: string
  hasSurveyMap: boolean | null
}

/** 03 所有権登記名義人 (立会人ブロック込)
 *  1 名義人ごとに 1 行。所有地 (parcels の複数筆) を parcelIndexes で保持する。 */
export interface ReportOwnerRow {
  /** parcels 配列のインデックス (複数筆保有時は複数)。表示・出力時に 左側に並べる */
  parcelIndexes: number[]
  landownerId: string | null            // landowners (地権者管理) の id
  address: string
  name: string
  idMethod: 'license' | 'idcard' | 'meishiki' | 'other' | null
  idMethodOther: string
  ownership: 'single' | 'joint' | null
  ownershipShare: string
  contact: string
  attendee: {
    address: string
    name: string
    idMethod: 'license' | 'idcard' | 'meishiki' | 'other' | null
    idMethodOther: string
    relation: 'family' | 'manager' | 'representative' | 'other' | null
    relationDetail: string
    contact: string
    remark: string
  }
}

/** 04 登記原因及びその日付 の 1 行 */
export interface ReportCauseRow {
  appNo: number
  parcelNumber: string
  causeDate: string     // ISO date
  cause: string
  reason: string
}

/** 09 基準点測量等 の 1 行 (基本三角点 / 補助基準点) */
export interface ReportBasePoint {
  coordinateId: string | null
  name: string           // 点名
  grade: string          // 等級・種別
  mark: string           // 標識 (=杭種)
}

/** 09 恒久的地物 の 1 行 */
export interface ReportPermanentFeature {
  coordinateId: string | null
  name: string           // 点名
  featureName: string    // 名称・種別
  objectName: string     // 地物の名称
}

/** 09 甲差検証 の 1 行 (02 の parcels とは独立に 都度選択する) */
export interface ReportKoosaRow {
  parcelId: string | null   // parcels のid (取込時にセット)
  location: string
  parcelNumber: string
  registeredAreaSqm: number | null
  measuredAreaSqm: number | null
}

/** 報告書 body の全体構造 */
export interface LandReportBody {
  meta: {
    reportDate: string          // ISO date
    reportNo: string
    surveyorId: string | null   // organization_surveyors.id
  }
  purposes: ReportPurposeRow[]            // 01 (可変)
  parcels: ReportParcelRow[]              // 02 (可変)
  owners: ReportOwnerRow[]                // 03 (parcels と同数)
  causes: ReportCauseRow[]                // 04 (可変)
  materials: Record<string, boolean | string>   // 05 (チェックボックス群)
  originalCheck: string                    // 06
  siteStatus: { attached: boolean }        // 07
  regionAccuracy: {                        // 08
    region: 'urban' | 'village' | 'mountain' | null
    accuracy: 'a1' | 'a2' | 'a3' | 'b1' | 'b2' | 'b3' | null
  }
  boundary: {                              // 09 上半
    coordSystem: {
      isWorld: boolean
      converterParam: string
      isCustom: boolean
      customLabel: string
    }
    devices: {
      ts: boolean
      gnss: boolean
      other: boolean
      otherText: string
    }
    methods: {
      radial: boolean
      closing: boolean
      loop: boolean
      intersection: boolean
      single: boolean
      opposite: boolean
      average: boolean
      other: boolean
      otherText: string
      static: boolean
      shortStatic: boolean
      rtk: boolean
      networkRtk: boolean
      gnssOther: boolean
      gnssOtherText: string
    }
    observationStart: string
    observationEnd: string
    basePoints: ReportBasePoint[]
    subBasePoints: ReportBasePoint[]
    permanentFeatures: ReportPermanentFeature[]
    photo1: { date: string; remark: string }
    photo2: { date: string; remark: string }
    noBaseTriangulationReason: string
  }
  singleParcelSurvey: {                    // 09 一筆地測量
    devices: {
      ts: boolean
      gnss: boolean
      other: boolean
      otherText: string
    }
    observationStart: string
    observationEnd: string
  }
  koosaRows: ReportKoosaRow[]              // 09 甲差検証 (可変)
  remark: string                           // 10
}

export const DEFAULT_LAND_REPORT_BODY: LandReportBody = {
  meta: { reportDate: '', reportNo: '', surveyorId: null },
  purposes: [],
  parcels: [],
  owners: [],
  causes: [],
  materials: {},
  originalCheck: '',
  siteStatus: { attached: false },
  regionAccuracy: { region: null, accuracy: null },
  boundary: {
    coordSystem: { isWorld: true, converterParam: '', isCustom: false, customLabel: '' },
    devices: { ts: false, gnss: false, other: false, otherText: '' },
    methods: {
      radial: false, closing: false, loop: false, intersection: false,
      single: false, opposite: false, average: false, other: false, otherText: '',
      static: false, shortStatic: false, rtk: false, networkRtk: false,
      gnssOther: false, gnssOtherText: '',
    },
    observationStart: '',
    observationEnd: '',
    basePoints: [],
    subBasePoints: [],
    permanentFeatures: [],
    photo1: { date: '', remark: '' },
    photo2: { date: '', remark: '' },
    noBaseTriangulationReason: '',
  },
  singleParcelSurvey: {
    devices: { ts: false, gnss: false, other: false, otherText: '' },
    observationStart: '',
    observationEnd: '',
  },
  koosaRows: [],
  remark: '',
}

export interface LandReport {
  id: string
  farmId: string
  title: string
  body: LandReportBody
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

/** 旧形式 owners (parcelIndex: number) を 新形式 (parcelIndexes: number[]) に寄せる */
function migrateOwners(body: Partial<LandReportBody>): Partial<LandReportBody> {
  if (!Array.isArray(body.owners)) return body
  const migrated = body.owners.map((o) => {
    const legacy = o as unknown as { parcelIndex?: number } & Partial<ReportOwnerRow>
    if (Array.isArray(legacy.parcelIndexes)) return o
    if (typeof legacy.parcelIndex === 'number') {
      return { ...o, parcelIndexes: [legacy.parcelIndex] } as ReportOwnerRow
    }
    return { ...o, parcelIndexes: [] } as ReportOwnerRow
  })
  return { ...body, owners: migrated }
}

const toReport = (r: Row): LandReport => ({
  id: r.id,
  farmId: r.farm_id,
  title: r.title,
  // 既存 body が 部分的でも DEFAULT_LAND_REPORT_BODY で埋めて型を安定させる
  body: { ...DEFAULT_LAND_REPORT_BODY, ...migrateOwners(r.body as Partial<LandReportBody>) },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface State {
  /** farm_id ごとの 報告書一覧 (キャッシュ) */
  byFarm: Map<string, LandReport[]>
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string) => Promise<void>
  createReport: (farmId: string, title?: string) => Promise<LandReport | null>
  updateReport: (
    id: string,
    patch: Partial<Pick<LandReport, 'title' | 'body'>>,
  ) => Promise<void>
  deleteReport: (id: string) => Promise<void>
}

export const useLandReportStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loading: false,
  error: null,

  fetchByFarm: async (farmId) => {
    set({ loading: true, error: null })
    const { data, error } = await supabase
      .from('land_reports')
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

  createReport: async (farmId, title = '無題の調査報告書') => {
    const payload = {
      farm_id: farmId,
      title,
      body: DEFAULT_LAND_REPORT_BODY as unknown as Record<string, unknown>,
    }
    const { data, error } = await supabase
      .from('land_reports')
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
      .from('land_reports')
      .update(dbPatch as never)
      .eq('id', id)
    if (error) {
      set({ error: error.message })
      return
    }
    // ローカルも更新
    const next = new Map(get().byFarm)
    for (const [farmId, list] of next) {
      const idx = list.findIndex((r) => r.id === id)
      if (idx >= 0) {
        const updated = { ...list[idx], ...patch, updatedAt: new Date().toISOString() } as LandReport
        const newList = [...list]
        newList[idx] = updated
        next.set(farmId, newList)
      }
    }
    set({ byFarm: next })
  },

  deleteReport: async (id) => {
    const { error } = await supabase.from('land_reports').delete().eq('id', id)
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
