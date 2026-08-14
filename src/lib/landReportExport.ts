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

/** テンプレ行内 (top==bottom==rowNum) の水平結合レンジを抽出 */
function getRowMerges(
  ws: ExcelJS.Worksheet,
  rowNum: number,
): Array<{ left: number; right: number }> {
  const wsAny = ws as unknown as {
    _merges?: Record<string, { model: { top: number; left: number; bottom: number; right: number } }>
  }
  if (!wsAny._merges) return []
  const results: Array<{ left: number; right: number }> = []
  for (const key of Object.keys(wsAny._merges)) {
    const m = wsAny._merges[key].model
    if (m.top === rowNum && m.bottom === rowNum) {
      results.push({ left: m.left, right: m.right })
    }
  }
  return results
}

/** ExcelJS の duplicateRow は 水平結合セルの マスター値を 全セルにコピーしてしまう。
 *  対策: duplicateRow で行を複製した後、
 *   1) 元行の結合レンジを 各新行で 一度アンマージ (もし残ってればクリーン化)
 *   2) 非マスターセルの value を null に (duplicateRow が入れたゴミを消す)
 *   3) 結合を再適用 */
function replicateRow(ws: ExcelJS.Worksheet, templateRow: number, count: number): void {
  if (count <= 0) return

  const rowMerges = getRowMerges(ws, templateRow)

  ws.duplicateRow(templateRow, count, true)

  for (let i = 1; i <= count; i++) {
    const newRowNum = templateRow + i
    for (const m of rowMerges) {
      // 1) この範囲を含む結合があれば アンマージ
      try {
        ws.unMergeCells(newRowNum, m.left, newRowNum, m.right)
      } catch {
        // 未結合なら例外 — 無視
      }
      // 2) 非マスターセルの値を null に
      for (let c = m.left + 1; c <= m.right; c++) {
        ws.getCell(newRowNum, c).value = null
      }
      // 3) 結合を再適用
      try {
        ws.mergeCells(newRowNum, m.left, newRowNum, m.right)
      } catch {
        // 稀に他 merge と衝突するときは スキップ
      }
    }
  }
}

function processSection<T>(
  ws: ExcelJS.Worksheet,
  spec: SectionSpec<T>,
  anchorRow: number,
  globalValues: Record<string, string>,
): number {
  const n = spec.items.length
  if (n === 0) {
    ws.spliceRows(anchorRow, 1)
    return 0
  }
  if (n > 1) {
    replicateRow(ws, anchorRow, n - 1)
  }
  let count = 0
  for (let i = 0; i < n; i++) {
    count += replaceRowTokens(ws, anchorRow + i, {
      ...globalValues,
      ...spec.rowValues(spec.items[i]),
    })
  }
  return count
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
  // 行番号が変わらないうちに 位置を把握しておく。
  const anchors = findAnchors(ws)

  // 下から順に処理すれば、上のアンカーの行番号は変わらない。
  const ordered = specs
    .map((spec) => ({ spec, row: anchors.get(spec.anchor) }))
    .filter((x): x is { spec: SectionSpec<unknown>; row: number } => typeof x.row === 'number')
    .sort((a, b) => b.row - a.row)

  let totalReplaced = 0
  for (const { spec, row } of ordered) {
    totalReplaced += processSection(ws, spec, row, globalValues)
  }

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
