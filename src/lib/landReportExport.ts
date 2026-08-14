// 土地調査報告書 の Excel 出力。
//
// 動き方:
//   1) public/調査報告書様式.xlsx を fetch
//   2) 未使用列に埋めた {{ANCHOR:XXX}} を検索し、可変行セクションを duplicateRow で伸ばす
//   3) 全セルの {{KEY}} トークンを 対応する値で置換
//   4) Blob として書き出す
//
// トークン仕様は 会話中の アンカー仕様書 と同じ。

import ExcelJS from 'exceljs'
import { supabase } from '@/lib/supabase'
import type {
  LandReport,
  LandReportBody,
  ReportPurposeRow,
  ReportParcelRow,
  ReportOwnerRow,
  ReportCauseRow,
  ReportBasePoint,
  ReportPermanentFeature,
} from '@/stores/landReportStore'

const TEMPLATE_URL = '/調査報告書様式.xlsx'

const CHECKED = '■'
const UNCHECKED = '□'
const check = (v: boolean) => (v ? CHECKED : UNCHECKED)

/** yyyy年MM月DD日。空 or 不正入力は '' */
function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
}

interface Surveyor {
  name: string
  registration_no: string | null
  office_name: string | null
  phone_no: string | null
}

async function loadSurveyor(surveyorId: string | null): Promise<Surveyor | null> {
  if (!surveyorId) return null
  const { data } = await supabase
    .from('organization_surveyors')
    .select('name, registration_no, office_name, phone_no')
    .eq('id', surveyorId)
    .maybeSingle<Surveyor>()
  return data
}

/** 固定セル用 (ヘッダ・05・06・07・08・09 一部・10) の値マップ */
function buildGlobalValues(body: LandReportBody, surveyor: Surveyor | null): Record<string, string> {
  const v: Record<string, string> = {}

  v['META_DATE'] = fmtDate(body.meta.reportDate)
  v['META_NO'] = body.meta.reportNo
  v['SURVEYOR_NAME'] = surveyor?.name ?? ''
  v['SURVEYOR_REG'] = surveyor?.registration_no ?? ''
  v['SURVEYOR_OFFICE'] = surveyor?.office_name ?? ''
  v['SURVEYOR_PHONE'] = surveyor?.phone_no ?? ''

  // 05
  const mat = body.materials
  const mb = (k: string) => check(mat[k] === true)
  v['M.DEED'] = mb('registered_deed')
  v['M.MAP'] = mb('map')
  v['M.MAP_ALT'] = mb('map_alternative')
  v['M.SURVEY_MAP'] = mb('survey_map')
  v['M.LOC_MAP'] = mb('location_map')
  v['M.BUILDING'] = mb('building_map')
  v['M.OLD_KOOZU'] = mb('old_koozu')
  v['M.AZA_MAP'] = mb('aza_map')
  v['M.BOUNDARY'] = mb('boundary_confirm')
  v['M.PAST_SURVEY'] = mb('past_survey')
  v['M.CITY_PLAN'] = mb('city_planning')
  v['M.AERIAL'] = mb('aerial_photo')
  v['M.NOTES'] = typeof mat['_notes'] === 'string' ? (mat['_notes'] as string) : ''

  // 06
  v['ORIGINAL_CHECK'] = body.originalCheck

  // 07
  v['SITE_ATTACHED'] = check(body.siteStatus.attached)

  // 08
  const ra = body.regionAccuracy
  v['R.URBAN'] = check(ra.region === 'urban')
  v['R.VILLAGE'] = check(ra.region === 'village')
  v['R.MOUNTAIN'] = check(ra.region === 'mountain')
  v['A.A1'] = check(ra.accuracy === 'a1')
  v['A.A2'] = check(ra.accuracy === 'a2')
  v['A.A3'] = check(ra.accuracy === 'a3')
  v['A.B1'] = check(ra.accuracy === 'b1')
  v['A.B2'] = check(ra.accuracy === 'b2')
  v['A.B3'] = check(ra.accuracy === 'b3')

  // 09 boundary (固定部)
  const bd = body.boundary
  v['COORD_WORLD'] = check(bd.coordSystem.isWorld)
  v['COORD_CUSTOM'] = check(bd.coordSystem.isCustom)
  v['COORD_PARAM'] = bd.coordSystem.converterParam
  v['COORD_CUSTOM_LABEL'] = bd.coordSystem.customLabel
  v['DEV_TS'] = check(bd.devices.ts)
  v['DEV_GNSS'] = check(bd.devices.gnss)
  v['DEV_OTHER'] = check(bd.devices.other)
  v['DEV_OTHER_TEXT'] = bd.devices.otherText
  const m = bd.methods
  v['MTH_RADIAL'] = check(m.radial)
  v['MTH_CLOSING'] = check(m.closing)
  v['MTH_LOOP'] = check(m.loop)
  v['MTH_INTER'] = check(m.intersection)
  v['MTH_SINGLE'] = check(m.single)
  v['MTH_OPPO'] = check(m.opposite)
  v['MTH_AVG'] = check(m.average)
  v['MTH_OTHER'] = check(m.other)
  v['MTH_OTHER_TEXT'] = m.otherText
  v['MTH_STATIC'] = check(m.static)
  v['MTH_SHORT_STATIC'] = check(m.shortStatic)
  v['MTH_RTK'] = check(m.rtk)
  v['MTH_NET_RTK'] = check(m.networkRtk)
  v['MTH_GNSS_OTHER'] = check(m.gnssOther)
  v['MTH_GNSS_OTHER_TEXT'] = m.gnssOtherText
  v['BND_OBS_START'] = fmtDate(bd.observationStart)
  v['BND_OBS_END'] = fmtDate(bd.observationEnd)
  v['PHOTO1_DATE'] = fmtDate(bd.photo1.date)
  v['PHOTO1_REMARK'] = bd.photo1.remark
  v['PHOTO2_DATE'] = fmtDate(bd.photo2.date)
  v['PHOTO2_REMARK'] = bd.photo2.remark
  v['NO_TRIANG_REASON'] = bd.noBaseTriangulationReason

  // 09 single
  const sg = body.singleParcelSurvey
  v['SG.DEV_TS'] = check(sg.devices.ts)
  v['SG.DEV_GNSS'] = check(sg.devices.gnss)
  v['SG.DEV_OTHER'] = check(sg.devices.other)
  v['SG.DEV_OTHER_TEXT'] = sg.devices.otherText
  v['SG.OBS_START'] = fmtDate(sg.observationStart)
  v['SG.OBS_END'] = fmtDate(sg.observationEnd)

  // 10
  v['REMARK'] = body.remark

  return v
}

// ---------------------------- per-row values ----------------------------

function purposeRowValues(r: ReportPurposeRow): Record<string, string> {
  return {
    'P.NO': String(r.appNo),
    'P.CHANGE': check(r.changeType === 'change'),
    'P.CORR': check(r.changeType === 'correction'),
    'P.EV_TITLE': check(r.events.title),
    'P.EV_SUB': check(r.events.subdivision),
    'P.EV_MERGE': check(r.events.merger),
    'P.EV_LOC': check(r.events.location),
    'P.EV_CAT': check(r.events.landCategory),
    'P.EV_AREA': check(r.events.area),
    'P.EV_MAP': check(r.events.mapCorrection),
    'P.EV_SURVEY': check(r.events.surveyMapCorrection),
    'P.EV_LOCMAP': check(r.events.locationMapCorrection),
    'P.EV_OTHER': check(r.events.other),
    'P.EV_OTHER_TEXT': r.events.otherText,
  }
}

function parcelRowValues(r: ReportParcelRow): Record<string, string> {
  return {
    'L.NO': String(r.appNo),
    'L.LOCATION': r.location,
    'L.NUMBER': r.parcelNumber,
    'L.CATEGORY': r.landCategory,
    'L.AREA': r.areaSqm != null ? r.areaSqm.toFixed(2) : '',
    'L.TP_YES': check(r.hasThirdPartyRight === true),
    'L.TP_NO': check(r.hasThirdPartyRight === false),
    'L.USAGE': r.usage,
    'L.SM_YES': check(r.hasSurveyMap === true),
    'L.SM_NO': check(r.hasSurveyMap === false),
  }
}

function ownerRowValues(r: ReportOwnerRow, parcels: ReportParcelRow[]): Record<string, string> {
  const parcelsText = r.parcelIndexes
    .map((i) => parcels[i])
    .filter((p): p is ReportParcelRow => Boolean(p))
    .map((p) => `${p.location} ${p.parcelNumber}`.trim())
    .join('\n')
  return {
    'O.PARCELS': parcelsText,
    'O.ADDRESS': r.address,
    'O.NAME': r.name,
    'O.CONTACT': r.contact,
    'O.SINGLE': check(r.ownership === 'single'),
    'O.JOINT': check(r.ownership === 'joint'),
    'O.SHARE': r.ownershipShare,
    'O.ID_LIC': check(r.idMethod === 'license'),
    'O.ID_CARD': check(r.idMethod === 'idcard'),
    'O.ID_MEI': check(r.idMethod === 'meishiki'),
    'O.ID_OTHER': check(r.idMethod === 'other'),
    'O.ID_OTHER_TEXT': r.idMethodOther,
    'O.ATT_ADDRESS': r.attendee.address,
    'O.ATT_NAME': r.attendee.name,
    'O.ATT_CONTACT': r.attendee.contact,
    'O.ATT_REL_FAM': check(r.attendee.relation === 'family'),
    'O.ATT_REL_MGR': check(r.attendee.relation === 'manager'),
    'O.ATT_REL_REP': check(r.attendee.relation === 'representative'),
    'O.ATT_REL_OTHER': check(r.attendee.relation === 'other'),
    'O.ATT_REL_DETAIL': r.attendee.relationDetail,
    'O.ATT_ID_LIC': check(r.attendee.idMethod === 'license'),
    'O.ATT_ID_CARD': check(r.attendee.idMethod === 'idcard'),
    'O.ATT_ID_MEI': check(r.attendee.idMethod === 'meishiki'),
    'O.ATT_ID_OTHER': check(r.attendee.idMethod === 'other'),
    'O.ATT_ID_OTHER_TEXT': r.attendee.idMethodOther,
    'O.ATT_REMARK': r.attendee.remark,
  }
}

function causeRowValues(r: ReportCauseRow): Record<string, string> {
  return {
    'C.NO': String(r.appNo),
    'C.PARCEL': r.parcelNumber,
    'C.DATE': fmtDate(r.causeDate),
    'C.CAUSE': r.cause,
    'C.REASON': r.reason,
  }
}

function basePointRowValues(prefix: 'BP' | 'SBP', r: ReportBasePoint): Record<string, string> {
  return {
    [`${prefix}.NAME`]: r.name,
    [`${prefix}.GRADE`]: r.grade,
    [`${prefix}.MARK`]: r.mark,
  }
}

function permFeatureRowValues(r: ReportPermanentFeature): Record<string, string> {
  return {
    'PF.NAME': r.name,
    'PF.FEATURE': r.featureName,
    'PF.OBJECT': r.objectName,
  }
}

// ---------------------------- anchor scan / token replace ----------------------------

function extractCellText(cell: ExcelJS.Cell): string | null {
  const raw = cell.value
  if (raw == null) return null
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object') {
    if ('richText' in raw && Array.isArray((raw as { richText: unknown }).richText)) {
      return (raw as { richText: Array<{ text: string }> }).richText
        .map((rt) => rt.text)
        .join('')
    }
    // formula / hyperlink / date / etc — skip
    return null
  }
  return null
}

const ANCHOR_RE = /\{\{ANCHOR:([A-Z_]+)\}\}/
const ANCHOR_RE_G = /\{\{ANCHOR:[A-Z_]+\}\}/g
const TOKEN_RE_G = /\{\{([A-Z0-9_.]+)\}\}/g

function findAnchors(ws: ExcelJS.Worksheet): Map<string, number> {
  const anchors = new Map<string, number>()
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = extractCellText(cell)
      if (!text) return
      const m = text.match(ANCHOR_RE)
      if (m) anchors.set(m[1], rowNum)
    })
  })
  return anchors
}

/** 置換したセル数を返す (診断用) */
function replaceCellTokens(cell: ExcelJS.Cell, values: Record<string, string>): number {
  const text = extractCellText(cell)
  if (!text || !text.includes('{{')) return 0
  const next = text
    .replace(ANCHOR_RE_G, '') // アンカーマーカー除去
    .replace(TOKEN_RE_G, (_, key: string) => values[key] ?? '')
  if (next === text) return 0
  cell.value = next
  // 改行を含むときは wrapText を有効化 (テンプレ側が未設定でも表示崩れしないように)
  if (next.includes('\n')) {
    cell.alignment = { ...(cell.alignment ?? {}), wrapText: true }
  }
  return 1
}

function replaceRowTokens(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  values: Record<string, string>,
): number {
  const row = ws.getRow(rowNum)
  let count = 0
  row.eachCell({ includeEmpty: false }, (cell) => {
    // 結合セルの非マスターは 触らない (触ると 結合が壊れることがある)
    if (cell.isMerged && cell.master && cell.master.address !== cell.address) return
    count += replaceCellTokens(cell, values)
  })
  return count
}

interface SectionSpec<T> {
  anchor: string
  items: T[]
  rowValues: (item: T) => Record<string, string>
}

// ---------------------------- merge snapshot / rebuild ----------------------------
//
// ExcelJS の duplicateRow / spliceRows は 結合セル (特に 水平結合) を
// 適切に扱えず、隣接する行や 上下の結合まで 破壊することがある。
// 対策として:
//   1) 何もする前に 全ての merge を スナップショット
//   2) 行操作 (duplicateRow / spliceRows) を 実行
//   3) 全ての merge を消去
//   4) スナップショットから シフト量を計算して merge を 再適用
//   5) 複製された各行にも 元テンプレ行の水平 merge を 追加適用
//
// この方式で、行操作による merge 破壊を 完全に無視できる。

interface MergeRange {
  top: number
  left: number
  bottom: number
  right: number
}

function getAllMerges(ws: ExcelJS.Worksheet): MergeRange[] {
  const wsAny = ws as unknown as {
    _merges?: Record<string, { model: MergeRange }>
  }
  if (!wsAny._merges) return []
  return Object.values(wsAny._merges).map((m) => ({ ...m.model }))
}

/** 内部の merge 索引を丸ごと消す。cell 側の _master 参照は残るが、
 *  出力 XML には反映されないので 実害はない (再 merge で上書きされる)。 */
function clearAllMerges(ws: ExcelJS.Worksheet): void {
  const wsAny = ws as unknown as { _merges?: Record<string, unknown> }
  wsAny._merges = {}
}

interface SectionJob {
  spec: SectionSpec<unknown>
  templateRow: number  // 元テンプレでの anchor 行番号
  count: number        // 挿入する行数 (items.length; 0 なら削除, 1 なら現状維持, 2+ なら count-1 行を挿入)
}

/** origRow が 全ジョブ適用後に どの行番号にシフトするかを 計算 */
function computeShift(origRow: number, jobs: SectionJob[]): number {
  let shifted = origRow
  for (const job of jobs) {
    if (job.count === 0) {
      // templateRow を 削除 → templateRow より下の 全行が 1 つ上へ
      if (origRow > job.templateRow) shifted -= 1
    } else if (job.count > 1) {
      // templateRow の後ろに count-1 行 挿入 → 挿入位置より下の 全行がずれる
      if (origRow > job.templateRow) shifted += job.count - 1
    }
  }
  return shifted
}

function processAllSections(
  ws: ExcelJS.Worksheet,
  jobs: SectionJob[],
  globalValues: Record<string, string>,
  buildRowValues: (job: SectionJob, itemIndex: number) => Record<string, string>,
): number {
  // 0) 全 merge をスナップショット
  const originalMerges = getAllMerges(ws)

  // 1) 各ジョブの テンプレ行の 水平 merge を キャッシュ (複製行に適用するため)
  const perTemplateRowMerges = new Map<number, MergeRange[]>()
  for (const job of jobs) {
    perTemplateRowMerges.set(
      job.templateRow,
      originalMerges.filter((m) => m.top === job.templateRow && m.bottom === job.templateRow),
    )
  }

  // 2) 行操作: 下から順に。値散らばりは 後でクリーンアップするので気にしない
  const bottomUp = [...jobs].sort((a, b) => b.templateRow - a.templateRow)
  for (const job of bottomUp) {
    if (job.count === 0) {
      ws.spliceRows(job.templateRow, 1)
    } else if (job.count > 1) {
      ws.duplicateRow(job.templateRow, job.count - 1, true)
    }
  }

  // 3) 全 merge を消す
  clearAllMerges(ws)

  // 4) 元 merge を シフトして再適用
  for (const m of originalMerges) {
    const nt = computeShift(m.top, jobs)
    const nb = computeShift(m.bottom, jobs)
    try {
      ws.mergeCells(nt, m.left, nb, m.right)
    } catch {
      // 稀に衝突 — 無視
    }
  }

  // 5) 複製された各行に テンプレ行の merge を コピー
  for (const job of jobs) {
    if (job.count <= 1) continue
    const templateNewRow = computeShift(job.templateRow, jobs)
    const rowMerges = perTemplateRowMerges.get(job.templateRow) ?? []
    for (let i = 1; i < job.count; i++) {
      for (const m of rowMerges) {
        try {
          ws.mergeCells(templateNewRow + i, m.left, templateNewRow + i, m.right)
        } catch {
          // 無視
        }
      }
    }
  }

  // 6) 複製行の 非マスターセルの値を null にして、トークンを置換
  let replaced = 0
  for (const job of jobs) {
    if (job.count === 0) continue
    const templateNewRow = computeShift(job.templateRow, jobs)
    const rowMerges = perTemplateRowMerges.get(job.templateRow) ?? []
    for (let i = 0; i < job.count; i++) {
      const rowNum = templateNewRow + i
      // 非マスターセルを空に (duplicateRow が入れた scattered な値を消す)
      for (const m of rowMerges) {
        for (let c = m.left + 1; c <= m.right; c++) {
          ws.getCell(rowNum, c).value = null
        }
      }
      // トークン置換
      replaced += replaceRowTokens(ws, rowNum, {
        ...globalValues,
        ...buildRowValues(job, i),
      })
    }
  }

  return replaced
}

// ---------------------------- main entry ----------------------------

export async function exportLandReportToExcel(report: LandReport): Promise<Blob> {
  const surveyor = await loadSurveyor(report.body.meta.surveyorId)
  const body = report.body

  // ブラウザキャッシュを避けて 常に最新テンプレートを取る
  const res = await fetch(`${TEMPLATE_URL}?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`テンプレートを取得できませんでした (${res.status})`)
  }
  const buffer = await res.arrayBuffer()

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('テンプレートにシートがありません')

  const globalValues = buildGlobalValues(body, surveyor)

  const specs: SectionSpec<unknown>[] = [
    { anchor: 'PURPOSES', items: body.purposes, rowValues: (r) => purposeRowValues(r as ReportPurposeRow) },
    { anchor: 'PARCELS', items: body.parcels, rowValues: (r) => parcelRowValues(r as ReportParcelRow) },
    { anchor: 'OWNERS', items: body.owners, rowValues: (r) => ownerRowValues(r as ReportOwnerRow, body.parcels) },
    { anchor: 'CAUSES', items: body.causes, rowValues: (r) => causeRowValues(r as ReportCauseRow) },
    { anchor: 'BASE_POINTS', items: body.boundary.basePoints, rowValues: (r) => basePointRowValues('BP', r as ReportBasePoint) },
    { anchor: 'SUB_BASE_POINTS', items: body.boundary.subBasePoints, rowValues: (r) => basePointRowValues('SBP', r as ReportBasePoint) },
    { anchor: 'PERM_FEATURES', items: body.boundary.permanentFeatures, rowValues: (r) => permFeatureRowValues(r as ReportPermanentFeature) },
  ]

  // 先に アンカーを全て検出。
  const anchors = findAnchors(ws)

  // アンカーが見つかったジョブだけ抽出
  const jobs: SectionJob[] = []
  for (const spec of specs) {
    const row = anchors.get(spec.anchor)
    if (typeof row === 'number') {
      jobs.push({ spec, templateRow: row, count: spec.items.length })
    }
  }

  // 可変行セクションを 一括処理 (merge スナップショット → 行操作 → merge 再構築)
  let totalReplaced = processAllSections(ws, jobs, globalValues, (job, i) =>
    job.spec.rowValues(job.spec.items[i]),
  )

  // 残りの 固定セル 全体に対して 一括置換
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      totalReplaced += replaceCellTokens(cell, globalValues)
    })
  })

  // アンカーもトークンも 一つも見つからない = テンプレが古い or トークン未配置
  if (anchors.size === 0 && totalReplaced === 0) {
    throw new Error(
      'テンプレートに {{...}} トークンが 1 つも見つかりませんでした。' +
        'public/調査報告書様式.xlsx が トークン埋め込み済みのファイルに置換されているか、' +
        'ブラウザキャッシュを強制リロード (Ctrl+Shift+R) して 再試行してください。',
    )
  }
  console.log('[landReportExport] anchors:', anchors.size, 'replacements:', totalReplaced)

  const outBuffer = await wb.xlsx.writeBuffer()
  return new Blob([outBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
