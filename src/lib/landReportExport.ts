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
  ReportKoosaRow,
} from '@/stores/landReportStore'
import {
  MATERIAL_GROUPS,
  MATERIALS_NOTES_KEY,
  MATERIALS_NOTES_TOKEN,
} from '@/features/boundary-survey/reportMaterials'
import { evaluateKoosa, type AccuracyClass } from './landReportKoosa'
import {
  embedLinkedPhotos,
  detectPhotoSlots,
  collectPhotoItems,
  photoBlockRowValues,
  embedPhotosInBlocks,
  type PhotoItem,
  type PhotoSlot,
} from './landReportPhotos'

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

  // 05 資料調査 (MATERIAL_GROUPS を反復して 全項目のトークンを生成)
  const mat = body.materials
  for (const group of MATERIAL_GROUPS) {
    for (const item of group.items) {
      v[`M.${item.token}`] = check(mat[item.key] === true)
      if (item.hasText && item.textKey && item.textToken) {
        const raw = mat[item.textKey]
        v[`M.${item.textToken}`] = typeof raw === 'string' ? raw : ''
      }
    }
  }
  v[`M.${MATERIALS_NOTES_TOKEN}`] =
    typeof mat[MATERIALS_NOTES_KEY] === 'string' ? (mat[MATERIALS_NOTES_KEY] as string) : ''

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
    'P.CHANGE': check(!!r.changeType?.change),
    'P.CORR': check(!!r.changeType?.correction),
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
  // 所在ごとにグルーピング: 「所在 番号1,番号2,番号3」 を 改行区切りで並べる
  const byLocation = new Map<string, string[]>()
  const locOrder: string[] = []
  for (const i of r.parcelIndexes) {
    const p = parcels[i]
    if (!p) continue
    const loc = p.location.trim()
    const num = p.parcelNumber.trim()
    if (!byLocation.has(loc)) {
      byLocation.set(loc, [])
      locOrder.push(loc)
    }
    byLocation.get(loc)!.push(num)
  }
  const parcelsText = locOrder
    .map((loc) => `${loc}${byLocation.get(loc)!.join(',')}`)
    .join('\n')
  // 立会人情報が 何か入力されていれば ■ (氏名 or 住所 or 連絡先 のいずれか)
  const hasAttendee = Boolean(
    r.attendee.name.trim() || r.attendee.address.trim() || r.attendee.contact.trim(),
  )
  return {
    'O.HAS_ATTENDEE': check(hasAttendee),
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

function koosaRowValues(
  r: ReportKoosaRow,
  idx: number,
  accuracy: AccuracyClass | null,
): Record<string, string> {
  const { diff, tolerance, verdict } = evaluateKoosa(
    accuracy,
    r.registeredAreaSqm,
    r.measuredAreaSqm,
  )
  return {
    'K.NO': String(idx + 1),
    'K.LOCATION': r.location,
    'K.NUMBER': r.parcelNumber,
    'K.REGISTERED': r.registeredAreaSqm != null ? r.registeredAreaSqm.toFixed(2) : '',
    'K.MEASURED': r.measuredAreaSqm != null ? r.measuredAreaSqm.toFixed(2) : '',
    'K.DIFF': diff != null ? diff.toFixed(2) : '',
    'K.TOLERANCE': tolerance != null ? tolerance.toFixed(2) : '',
    'K.RESULT': verdict === 'ok' ? '適' : verdict === 'ng' ? '不適' : '',
    // 地積更正の要否 (□要 □否): 不適 → 要, 適 → 否
    'K.NEEDS_CORR_YES': verdict === 'ng' ? '■' : '□',
    'K.NEEDS_CORR_NO':  verdict === 'ok' ? '■' : '□',
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
    // hyperlink オブジェクト: { text, hyperlink }
    if ('text' in raw && typeof (raw as { text: unknown }).text === 'string') {
      return (raw as { text: string }).text
    }
    // formula 型: { formula, result }
    if ('result' in raw && (raw as { result: unknown }).result != null) {
      const r = (raw as { result: unknown }).result
      if (typeof r === 'string') return r
      if (typeof r === 'number' || typeof r === 'boolean') return String(r)
    }
  }
  // 最後の手段: ExcelJS の 正規化テキスト取得 (稀に内部で toString 失敗するので try/catch)
  try {
    const t = cell.text
    if (typeof t === 'string' && t.length > 0) return t
  } catch {
    // ignore
  }
  return null
}

// アンカー記法:
//   {{ANCHOR:NAME}}                — 1 行アンカー (行を N 回複製)
//   {{ANCHOR:NAME:START}}          — 複数行ブロックの先頭行 (印刷範囲外セルに配置)
//   {{ANCHOR:NAME:END}}            — 複数行ブロックの最終行 (印刷範囲外セルに配置)
const ANCHOR_RE = /\{\{ANCHOR:([A-Z_]+)(?::(START|END))?\}\}/
const ANCHOR_RE_G = /\{\{ANCHOR:[A-Z_]+(?::(?:START|END))?\}\}/g
const TOKEN_RE_G = /\{\{([A-Z0-9_.]+)\}\}/g

interface AnchorInfo {
  startRow: number
  endRow: number  // 単一行なら startRow と同じ
}

/** 指定名の アンカーが現在どのセル (行/列) にあるかを 探す。
 *  行操作後の 実位置を取りたいときに使う。見つからなければ null。 */
function findAnchorCell(
  ws: ExcelJS.Worksheet,
  name: string,
): { row: number; col: number } | null {
  const target = `{{ANCHOR:${name}}}`
  let found: { row: number; col: number } | null = null
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (found) return
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      if (found) return
      const text = extractCellText(cell)
      if (text && text.includes(target)) {
        found = { row: rowNum, col: colNum }
      }
    })
  })
  return found
}

function findAnchors(ws: ExcelJS.Worksheet): Map<string, AnchorInfo> {
  const single = new Map<string, number>()
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = extractCellText(cell)
      if (!text) return
      const m = text.match(ANCHOR_RE)
      if (!m) return
      const name = m[1]
      const kind = m[2]
      if (kind === 'START') starts.set(name, rowNum)
      else if (kind === 'END') ends.set(name, rowNum)
      else single.set(name, rowNum)
    })
  })

  const result = new Map<string, AnchorInfo>()
  for (const [name, row] of single) {
    result.set(name, { startRow: row, endRow: row })
  }
  for (const [name, startRow] of starts) {
    const endRow = ends.get(name) ?? startRow
    result.set(name, { startRow, endRow })
  }
  return result
}

/** 置換したセル数を返す (診断用) */
function replaceCellTokens(cell: ExcelJS.Cell, values: Record<string, string>): number {
  const text = extractCellText(cell)
  if (!text || !text.includes('{{')) return 0
  const next = text
    .replace(ANCHOR_RE_G, '') // アンカーマーカー除去
    .replace(TOKEN_RE_G, (_, key: string) => values[key] ?? '')
  if (next === text) return 0

  // 置換後の内容が 小数点付きの数値 のときだけ Number として set する。
  //   * "336.00" のような 面積値 → 数値化して Excel の書式が効くように
  //   * "343" (整数のみ) や "440-2" などは 地番 / 番号 として テキスト維持
  //   * "0153882626" (先頭 0) は 電話番号 なので テキスト維持
  //   * セルの numFmt が未設定なら '0.00' を既定として付与
  //     (テンプレ側で 特定の書式を設定していれば それが優先される)
  const trimmed = next.trim()
  const isDecimalNumber = /^-?\d+\.\d+$/.test(trimmed)
  if (trimmed !== '' && isDecimalNumber) {
    cell.value = parseFloat(trimmed)
    const currentFmt = cell.numFmt
    if (!currentFmt || currentFmt === 'General' || currentFmt === '@') {
      cell.numFmt = '0.00'
    }
  } else {
    cell.value = next
    // 改行を含むときは wrapText を有効化
    if (next.includes('\n')) {
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: true }
    }
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
  rowValues: (item: T, index: number) => Record<string, string>
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
  /** 元テンプレでの ブロック先頭行 */
  startRow: number
  /** 元テンプレでの ブロック最終行 (1 行アンカーなら startRow と同じ) */
  endRow: number
  /** items.length。0 なら削除, 1 なら現状維持, 2+ なら (count-1) ブロック分 追加 */
  count: number
}

function blockHeight(job: SectionJob): number {
  return job.endRow - job.startRow + 1
}

/** origRow が 全ジョブ適用後に どの行番号にシフトするかを 計算。
 *  count=0 のときは 行削除しない仕様に変更したので、シフトは count > 1 のみを考慮。 */
function computeShift(origRow: number, jobs: SectionJob[]): number {
  let shifted = origRow
  for (const job of jobs) {
    const h = blockHeight(job)
    if (job.count > 1) {
      if (origRow > job.endRow) shifted += (job.count - 1) * h
    }
  }
  return shifted
}

interface CellSnapshot {
  rowOffset: number
  col: number
  value: ExcelJS.CellValue
  style: Partial<ExcelJS.Style>
}

interface BlockSnapshot {
  cells: CellSnapshot[]
  /** ブロック内 merges (top/bottom はブロック内相対 offset) */
  merges: MergeRange[]
  heights: (number | undefined)[]
}

/** セルが 罫線 or 塗りつぶし を持つか (値なしでも スナップショットに含めるべきか判定) */
function hasVisibleStyle(cell: ExcelJS.Cell): boolean {
  const b = cell.border
  if (b) {
    if (b.top?.style || b.bottom?.style || b.left?.style || b.right?.style) return true
  }
  const f = cell.fill
  if (f && (f as { type?: string }).type) return true
  return false
}

function snapshotBlock(
  ws: ExcelJS.Worksheet,
  startRow: number,
  endRow: number,
  originalMerges: MergeRange[],
): BlockSnapshot {
  const cells: CellSnapshot[] = []
  const heights: (number | undefined)[] = []
  // eachCell が 「使用中」 と判定するセルしか巡回しないため、
  // 右端の 「罫線のみ」 セルを 見逃すことがある。1〜maxCol を 明示的に iterate する。
  const maxCol = Math.max(60, ws.columnCount || 0, ws.actualColumnCount || 0)
  for (let r = startRow; r <= endRow; r++) {
    heights.push(ws.getRow(r).height)
    const row = ws.getRow(r)
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c)
      // マスターセルのみ取得 (非マスターは merge の裏に隠れる)
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue
      const hasValue = cell.value != null
      const hasStyle = hasVisibleStyle(cell)
      if (!hasValue && !hasStyle) continue
      cells.push({
        rowOffset: r - startRow,
        col: c,
        value: cell.value,
        style: {
          alignment: cell.alignment,
          border: cell.border,
          fill: cell.fill as ExcelJS.Fill,
          font: cell.font,
          numFmt: cell.numFmt,
        },
      })
    }
  }
  const merges = originalMerges
    .filter((m) => m.top >= startRow && m.bottom <= endRow)
    .map((m) => ({
      top: m.top - startRow,
      bottom: m.bottom - startRow,
      left: m.left,
      right: m.right,
    }))
  return { cells, merges, heights }
}

function applyBlockSnapshot(
  ws: ExcelJS.Worksheet,
  snap: BlockSnapshot,
  copyStartRow: number,
): void {
  for (let i = 0; i < snap.heights.length; i++) {
    const h = snap.heights[i]
    if (h != null) ws.getRow(copyStartRow + i).height = h
  }
  for (const cd of snap.cells) {
    const cell = ws.getRow(copyStartRow + cd.rowOffset).getCell(cd.col)
    cell.value = cd.value
    if (cd.style.alignment) cell.alignment = cd.style.alignment
    if (cd.style.border) cell.border = cd.style.border
    if (cd.style.fill) cell.fill = cd.style.fill
    if (cd.style.font) cell.font = cd.style.font
    if (cd.style.numFmt) cell.numFmt = cd.style.numFmt
  }
  for (const bm of snap.merges) {
    const newTop = copyStartRow + bm.top
    const newBottom = copyStartRow + bm.bottom
    try {
      ws.mergeCells(newTop, bm.left, newBottom, bm.right)
    } catch {
      // 無視
    }
  }
}

/** 事前スキャン: シートの 「外周フレーム」 (最左と最右の 縦罫線) を検出。
 *  「right border を持つセル」の 最左カラム と 最右カラム が 外周フレーム。
 *  内部の 罫線 (テーブル区切りなど) は 触らない。 */
type BorderSide = { style?: string; color?: unknown }
interface FrameInfo {
  leftFrameCol: number   // 最左の 縦フレーム線が引かれる カラム (right border を持つ)
  rightFrameCol: number  // 最右の 縦フレーム線が引かれる カラム
  border?: BorderSide    // フレームの罫線スタイル (最初に見つかったものをサンプル)
  /** 元テンプレで leftFrameCol に 罫線があった行 (絶対行番号) */
  leftFrameRows: Set<number>
  /** 元テンプレで rightFrameCol に 罫線があった行 */
  rightFrameRows: Set<number>
}
function detectOuterFrame(ws: ExcelJS.Worksheet): FrameInfo {
  const maxRow = Math.max(200, ws.rowCount || 0, ws.actualRowCount || 0)
  const maxCol = Math.max(80, ws.columnCount || 0, ws.actualColumnCount || 0)
  // 各カラムの 「そのカラムで right border を持つ行」 の Set を作成
  const rowsByCol = new Map<number, Set<number>>()
  let sample: BorderSide | undefined
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r)
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c)
      const rb = cell.border?.right
      if (!rb?.style) continue
      let s = rowsByCol.get(c)
      if (!s) {
        s = new Set()
        rowsByCol.set(c, s)
      }
      s.add(r)
      if (!sample) sample = rb as BorderSide
    }
  }
  // right border を持つカラムのうち 最左 (=左枠) と 最右 (=右枠) だけを採用
  const cols = Array.from(rowsByCol.keys()).sort((a, b) => a - b)
  const leftCol = cols[0] ?? -1
  const rightCol = cols[cols.length - 1] ?? -1
  return {
    leftFrameCol: leftCol,
    rightFrameCol: rightCol,
    border: sample,
    leftFrameRows: leftCol > 0 ? rowsByCol.get(leftCol)! : new Set(),
    rightFrameRows: rightCol > 0 ? rowsByCol.get(rightCol)! : new Set(),
  }
}

/** 元テンプレで frame 罫線があった行を、行操作後の位置 (シフト & 複製) に stamp する。
 *  "right of col X" の代わりに "left of col X+1" として書き込む。
 *  こうすると col X が (左の列と結合された) 非マスターセルであっても、
 *  col X+1 は 印刷範囲外 で 単独セルであることが多いため 確実に border を write できる。 */
function stampFrameRowsPrecise(
  ws: ExcelJS.Worksheet,
  frame: FrameInfo,
  jobs: SectionJob[],
): void {
  if (!frame.border) return
  const applyLeftOnNext = (targetRow: number, col: number) => {
    if (col <= 0) return
    // col の "right border" は、代わりに col+1 の "left border" として stamp
    const cell = ws.getRow(targetRow).getCell(col + 1)
    if (cell.isMerged && cell.master && cell.master.address !== cell.address) return
    const cur = (cell.border ?? {}) as Record<string, BorderSide | undefined>
    if (cur.left?.style) return
    cell.border = { ...cur, left: frame.border } as unknown as ExcelJS.Borders
  }
  const process = (origRows: Set<number>, col: number) => {
    for (const origRow of origRows) {
      // 元位置のシフト後
      const shifted = computeShift(origRow, jobs)
      applyLeftOnNext(shifted, col)
      // 複製ブロック内なら、各コピーにも stamp
      for (const job of jobs) {
        if (job.count <= 1) continue
        if (origRow < job.startRow || origRow > job.endRow) continue
        const h = blockHeight(job)
        const blockShifted = computeShift(job.startRow, jobs)
        const rowOffset = origRow - job.startRow
        for (let i = 1; i < job.count; i++) {
          applyLeftOnNext(blockShifted + i * h + rowOffset, col)
        }
      }
    }
  }
  process(frame.leftFrameRows, frame.leftFrameCol)
  process(frame.rightFrameRows, frame.rightFrameCol)
}


function processAllSections(
  ws: ExcelJS.Worksheet,
  jobs: SectionJob[],
  globalValues: Record<string, string>,
  buildRowValues: (job: SectionJob, itemIndex: number) => Record<string, string>,
): number {
  // 0) 全 merge をスナップショット
  const originalMerges = getAllMerges(ws)

  // 0.5) 外周フレームの 左右カラムを 事前検出 (行操作の前に取る)
  const outerFrame = detectOuterFrame(ws)

  // 1) 各ジョブのブロックを スナップショット (values + styles + 内部 merges)
  const blockSnapshots = new Map<SectionJob, BlockSnapshot>()
  for (const job of jobs) {
    blockSnapshots.set(job, snapshotBlock(ws, job.startRow, job.endRow, originalMerges))
  }

  // 2) 行操作: 下から順に (元 startRow ベースで) 空行を挿入
  //    count=0 は 行を削除しない: 削除すると 隣接する行を跨ぐ merge
  //    (例: セクションのタイトルセルが 見出し行 + データ行 に縦結合) が壊れて
  //    値が散らばる問題がある。0 件のときは トークンだけ空文字に置換して
  //    行構造 + merge を保持する (後段の 全体トークン置換で {{...}} は '' に)。
  const bottomUp = [...jobs].sort((a, b) => b.startRow - a.startRow)
  for (const job of bottomUp) {
    const h = blockHeight(job)
    if (job.count === 0) {
      // 削除しない (後段でトークンは空文字化される)
      continue
    } else if (job.count > 1) {
      const extraRows = (job.count - 1) * h
      const emptyRows = Array.from({ length: extraRows }, () => [] as unknown[])
      ws.spliceRows(job.endRow + 1, 0, ...emptyRows)
    }
  }

  // 3) 全 merge を消す
  clearAllMerges(ws)

  // 4) 元 merge を シフトして再適用 (ブロック内 merge は 除外 — 5) で ブロックごとに扱う)
  //    Wrapper merge (m.top < j.startRow AND m.bottom >= j.endRow) は
  //    ブロックが count 回複製された場合、bottom を (count-1)*h 分 拡張する。
  //    (例: セクションのタイトルセルが 「見出し行 + データ行」 に縦結合されている場合、
  //     データ行が 2 行に増えたら タイトルセルも 3 行 縦マージにする)
  const insideBlock = (m: MergeRange): boolean =>
    jobs.some((j) => m.top >= j.startRow && m.bottom <= j.endRow)
  for (const m of originalMerges) {
    if (insideBlock(m)) continue
    let nt = computeShift(m.top, jobs)
    let nb = computeShift(m.bottom, jobs)
    if (nt < 0 || nb < 0) continue
    // Wrapper merge の bottom 拡張
    for (const job of jobs) {
      if (job.count <= 1) continue
      const extraRows = (job.count - 1) * blockHeight(job)
      const isWrapper =
        m.top < job.startRow && m.bottom >= job.startRow && m.bottom <= job.endRow
      if (isWrapper) nb += extraRows
    }
    try {
      ws.mergeCells(nt, m.left, nb, m.right)
    } catch {
      // 稀に衝突 — 無視
    }
  }

  // 5) 各ブロックについて、count 個のコピーを配置 (values + styles + 内部 merges)
  //    最初のコピー (copyIdx=0) は 元 startRow のシフト後位置 (values は既にあるが 上書きしても等価)
  let replaced = 0
  for (const job of jobs) {
    if (job.count === 0) continue
    const snap = blockSnapshots.get(job)
    if (!snap) continue
    const h = blockHeight(job)
    const blockNewStart = computeShift(job.startRow, jobs)
    if (blockNewStart < 0) continue

    for (let copyIdx = 0; copyIdx < job.count; copyIdx++) {
      const copyStart = blockNewStart + copyIdx * h
      applyBlockSnapshot(ws, snap, copyStart)
      // トークン置換 (item ごとの値で)
      for (let i = 0; i < h; i++) {
        replaced += replaceRowTokens(ws, copyStart + i, {
          ...globalValues,
          ...buildRowValues(job, copyIdx),
        })
      }
    }
  }

  // 6) 外周フレームを stamp:
  //    元テンプレで 縦罫線が引かれていた行だけを 対象とする (行ピンポイント方式)。
  //    行操作後のシフト位置 + 複製コピー位置 に stamp する。
  //    これで:
  //    - 元々罫線がない行 (ヘッダ / 末尾空行) には stamp しない
  //    - 元々罫線がある行は シフト & 複製後も 罫線を維持
  console.log('[processAllSections] outer frame:', {
    leftCol: outerFrame.leftFrameCol,
    rightCol: outerFrame.rightFrameCol,
    borderStyle: outerFrame.border?.style,
    leftRows: outerFrame.leftFrameRows.size,
    rightRows: outerFrame.rightFrameRows.size,
  })
  stampFrameRowsPrecise(ws, outerFrame, jobs)

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

  const accuracy = body.regionAccuracy.accuracy as AccuracyClass | null
  const specs: SectionSpec<unknown>[] = [
    { anchor: 'PURPOSES', items: body.purposes, rowValues: (r) => purposeRowValues(r as ReportPurposeRow) },
    { anchor: 'PARCELS', items: body.parcels, rowValues: (r) => parcelRowValues(r as ReportParcelRow) },
    { anchor: 'OWNERS', items: body.owners, rowValues: (r) => ownerRowValues(r as ReportOwnerRow, body.parcels) },
    { anchor: 'CAUSES', items: body.causes, rowValues: (r) => causeRowValues(r as ReportCauseRow) },
    { anchor: 'BASE_POINTS', items: body.boundary.basePoints, rowValues: (r) => basePointRowValues('BP', r as ReportBasePoint) },
    { anchor: 'SUB_BASE_POINTS', items: body.boundary.subBasePoints, rowValues: (r) => basePointRowValues('SBP', r as ReportBasePoint) },
    { anchor: 'PERM_FEATURES', items: body.boundary.permanentFeatures, rowValues: (r) => permFeatureRowValues(r as ReportPermanentFeature) },
    { anchor: 'KOOSA', items: body.koosaRows, rowValues: (r, i) => koosaRowValues(r as ReportKoosaRow, i, accuracy) },
  ]

  // 先に アンカーを全て検出。
  const anchors = findAnchors(ws)

  // 写真ブロック の 事前準備:
  //   PHOTOS が 複数行アンカー (START/END) で、内部に {{PHOTO_IMG_N}} スロットが
  //   1 個以上あれば ブロックモード。事前に写真を fetch + グループ化して 動的に
  //   specs に加える (下段の processAllSections で ブロック複製される)。
  const photosAnchor = anchors.get('PHOTOS')
  let photoBlockCtx: {
    slots: PhotoSlot[]
    photos: PhotoItem[]
    groupCount: number
    startRow: number
    endRow: number
  } | null = null
  if (photosAnchor && photosAnchor.startRow !== photosAnchor.endRow) {
    const slots = detectPhotoSlots(ws, photosAnchor.startRow, photosAnchor.endRow, extractCellText)
    const photos = await collectPhotoItems(body)
    if (slots.length > 0 && photos.length > 0) {
      const slotsPerBlock = slots.length
      const groupCount = Math.ceil(photos.length / slotsPerBlock)
      const groups: PhotoItem[][] = []
      for (let i = 0; i < groupCount; i++) {
        groups.push(photos.slice(i * slotsPerBlock, (i + 1) * slotsPerBlock))
      }
      photoBlockCtx = {
        slots,
        photos,
        groupCount,
        startRow: photosAnchor.startRow,
        endRow: photosAnchor.endRow,
      }
      // PHOTOS を specs に追加 (rowValues で PHOTO_CAP_i / PHOTO_DATE_i を埋める)
      specs.push({
        anchor: 'PHOTOS',
        items: groups,
        rowValues: (grp) => photoBlockRowValues(grp as PhotoItem[]),
      })
      console.log('[landReportExport] photo block mode:', {
        slots: slotsPerBlock, photos: photos.length, groups: groupCount,
      })
    }
  }

  // アンカーが見つかったジョブだけ抽出
  const jobs: SectionJob[] = []
  for (const spec of specs) {
    const info = anchors.get(spec.anchor)
    if (info) {
      jobs.push({
        spec,
        startRow: info.startRow,
        endRow: info.endRow,
        count: spec.items.length,
      })
    }
  }

  // 可変行セクションを 一括処理 (merge スナップショット → 行操作 → merge 再構築)
  let totalReplaced = processAllSections(ws, jobs, globalValues, (job, i) =>
    job.spec.rowValues(job.spec.items[i], i),
  )

  // 写真 の 画像埋込
  if (photoBlockCtx) {
    // ブロックモード: 各ブロックコピーの スロット位置に 画像を埋込
    const photosJob = jobs.find((j) => j.spec.anchor === 'PHOTOS')
    if (photosJob) {
      const blockHeightVal = photosJob.endRow - photosJob.startRow + 1
      const shiftedStart = (function compute(): number {
        let s = photosJob.startRow
        for (const j of jobs) {
          if (j.count > 1 && photosJob.startRow > j.endRow) {
            s += (j.count - 1) * (j.endRow - j.startRow + 1)
          }
        }
        return s
      })()
      try {
        const n = await embedPhotosInBlocks(
          wb, ws, photoBlockCtx.photos, photoBlockCtx.slots, shiftedStart, blockHeightVal,
        )
        console.log('[landReportExport] photos embedded (block mode):', n)
      } catch (e) {
        console.warn('[landReportExport] block-mode photo embed failed', e)
      }
    }
  } else {
    // 従来モード: 単一セル {{ANCHOR:PHOTOS}} を左上として グリッド埋込
    const photoAnchor = findAnchorCell(ws, 'PHOTOS')
    if (photoAnchor) {
      console.log('[landReportExport] photo anchor (legacy mode) at', photoAnchor)
      try {
        await embedLinkedPhotos(wb, ws, body, photoAnchor.row, photoAnchor.col)
      } catch (e) {
        console.warn('[landReportExport] embed photos failed', e)
      }
    } else {
      console.warn('[landReportExport] {{ANCHOR:PHOTOS}} が見つかりません (テンプレに配置されていない or 既に置換済み)')
    }
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
