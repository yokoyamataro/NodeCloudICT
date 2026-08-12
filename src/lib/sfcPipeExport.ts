// SFC (SCADEC ASCII) 形式で 配線 (吸水/集水/落口 …) を出力する。
//
// 仕様概要:
//  - ISO-10303-21 準拠、SXF Level 2 の pre-defined feature を利用
//  - 管種ごとに sfig_org + layer_feature を分ける
//  - 各配線は 2 頂点なら line_feature、3 頂点以上なら polyline_feature 1 本で
//  - 管種が変わる接続点には 記号レイヤに 1mm (paper) の circle_feature
//  - 内部座標は 実測 mm (real_meters × 1000)、sfig_locate で 1/scale 縮尺
//    → 例: 1/1000 のとき scale=1000、locate scale=0.001。実座標 250m は
//         内部 250,000 として出力し、locate 適用後は 250 mm (紙上)。
//  - Shift-JIS で出力（既存 TrendOne 出力と同様）
//  - 施工計画 (planGroups) を渡すと 測点名/地盤高/計画高/切深/勾配 の text_string_feature も出力
//
// SXF の feature 引数順は (layer, color, font, width, …)。
// color/font/width は SXF 標準の絶対インデックスを参照する
// (pre_defined_*_feature 宣言はそれらを "使う" ことの明示のみ):
//   色:   1=black 2=red 3=green 4=blue 5=yellow 6=magenta 7=cyan …
//   線種: 1=continuous 2=dashed 3=dashed_spaced …
//   線幅: 1=0.13 2=0.18 3=0.25 4=0.35 5=0.50 6=0.70 …
//
// 文字は text_string_feature で top-level に配置 (sfig_org 外)。
// 現地座標保持モードでも 文字は "用紙 mm" で 直接出力する
// (見た目を保つため、locate 変換の外に置く)。

import type { PipeRow } from '@/stores/underdrainStore'
import { PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import type { PipeType } from '@/types/database'
import type { PlanGroup, PlanPoint } from '@/stores/constructionPlanStore'

export interface SfcExportOptions {
  /** ファイル名 (拡張子除く) */
  fileBaseName?: string
  /** 図面縮尺 (例: 1000 → 1/1000) */
  scale?: number
  /**
   * true のとき、feature 内の座標を 現地座標 (mm 単位 = 実 m × 1000) に
   * 保存し、TREND-ONE の "現地座標" 系ファイルと同じ骨組み
   * (背景色 sfig の中に実 feature、level-2 マーカー sfig と sfig_locate で
   * 変換宣言) で出力する。
   */
  preserveSurveyCoords?: boolean
  /**
   * 用紙上の回転角 (度、CCW を正)。preserveSurveyCoords 時のみ意味を持つ。
   * SXF 側には (360 - rotationDeg) mod 360 として書き込む
   * (test-2 の 22.75° 入力 → 337.25° 出力の関係を踏襲)
   */
  rotationDeg?: number
  /**
   * データの原点 X, Y (実 m)。指定時は この座標を用紙上の左下 margin 位置
   * に来るよう配置。回転もこの原点まわりで適用される。
   * 未指定時は 全 vertex の bbox 最小点を原点にする。
   */
  originX?: number
  originY?: number
  /** 施工計画 (テキスト要素の元データ)。未指定なら テキストは出力しない。 */
  planGroups?: PlanGroup[]
  /** どの要素を出すかの ON/OFF フラグ */
  include?: {
    pipeShapes?: boolean       // 配線 (polyline/line) — default true
    transitions?: boolean      // 管種切替の 1mm 円 — default true
    pipeNumbers?: boolean      // 配線番号 — default true (planGroups があるとき有効)
    pointNames?: boolean       // 測点名 — default true
    groundHeight?: boolean     // 地盤高 — default true
    plannedHeight?: boolean    // 計画高 — default true
    cutDepth?: boolean         // 切深 — default true
    segmentSlope?: boolean     // 区間勾配 — default true
    segmentDistance?: boolean  // 区間距離 — default true
    pipeDiameter?: boolean     // 管径 — default true
  }
  /** テキスト系の細かい設定 */
  textOptions?: {
    moji?: number              // 文字サイズ mm (default 2)
    pipeNumberSize?: number    // 配線番号サイズ (default 2.5)
    absorptionStdDepth?: number  // 吸水標準切深 (default 0.8)
    collectorStdDepth?: number   // 集水標準切深 (default 0.9)
    /** 切深を 標準切深と異なる場合のみ 出力する (default true)。
     *  false にすると 標準と一致する切深も 全部出力する */
    cutDepthOnlyIfDiffFromStd?: boolean
  }
  /** 用紙サイズ 明示指定 (mm)。未指定なら bbox から自動選択。 */
  paperSize?: 'A0' | 'A1' | 'A2' | 'A3'
  /** 図面最上部に大きく描くタイトル (例: '暗渠施工図')。空/未指定なら描画しない */
  title?: string
  /** 現場名 (図面上部左寄せ)。空/未指定なら描画しない */
  projectName?: string | null
  /** 工区名 (図面上部右寄せ)。空/未指定なら描画しない */
  subtitle?: string | null
  /** 上端右に方位マーク (N) を描く */
  showNorthArrow?: boolean
  /** 参照点 (基準点)。x=北, y=東 (PipeVertex 系)。z (標高), remarks (備考) は表出力用 */
  referencePoints?: Array<{
    x: number
    y: number
    z?: number | null
    label: string
    remarks?: string | null
  }>
  /** 工事区域ポリゴン。各 points は x=北, y=東 */
  workAreas?: Array<{
    name?: string
    points: Array<{ x: number; y: number; label: string }>
  }>
  /** 基準杭座標一覧表 を右下に描画する (default false) */
  showReferenceTable?: boolean
  /** 座標系ラベル (表フッタ)。'2024' | '2011' | 'custom' */
  coordinateSystem?: '2024' | '2011' | 'custom'
}

// SXF 標準の色コード (使う分だけ列挙)。TREND-ONE が出力した参照 SFC の
// polyline_feature('4','13','3','4',…) から lightblue=13 を確認済み。
const COLOR_CODE = {
  black: 1,
  red: 2,
  green: 3,
  blue: 4,
  yellow: 5,
  magenta: 6,
  cyan: 7,
  lightblue: 13,
} as const
type ColorName = keyof typeof COLOR_CODE
// pre_defined_colour_feature 宣言 (使う色だけ)
const DECLARED_COLORS: ColorName[] = ['black', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'lightblue']

// SXF 標準の線種コード
const FONT_CONTINUOUS = 1
const FONT_DASHED = 2

// SXF 標準の線幅コード
const WIDTH_025 = 3 // 0.25mm
const WIDTH_035 = 4 // 0.35mm

// 管種 → 色 (TREND-ONE 参照ファイルに合わせる)
const PIPE_TYPE_COLOR: Record<string, ColorName> = {
  main: 'magenta',       // 集水
  branch: 'lightblue',   // 吸水
  outlet: 'green',       // 落口
  connection: 'green',   // 連絡渠
  spring: 'green',       // 湧水処理
  auxiliary: 'green',    // 補助暗渠
  self_funded: 'green',  // 自費施工
}

// 管種 → 線種 (吸水は dashed)
function fontForPipeType(pt: string): number {
  return pt === 'branch' ? FONT_DASHED : FONT_CONTINUOUS
}

/**
 * 動作確認用: 極小の SFC 文字列を返す。sfig を使わず、線 1 本だけを
 * A3 縦 (420×594) のシート内 (100,100)-(300,200) 座標に描画する。
 * TrendOne が受理する最小構成の確認に使う。
 */
export function generateMinimalSfcContent(): string {
  const now = new Date()
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  const out: string[] = []
  const emit = (body: string) => {
    out.push('/*SXF')
    out.push(body)
    out.push('SXF*/')
    out.push('')
  }
  out.push('ISO-10303-21;')
  out.push('HEADER;')
  out.push("FILE_DESCRIPTION(('SCADEC level2 feature_mode'),")
  out.push("        '2;1');")
  out.push("FILE_NAME('test.sfc',")
  out.push(`        '${iso}',`)
  out.push("        (''),")
  out.push("        (''),")
  out.push("        'SCADEC_API_Ver3.30$$3.1',")
  out.push("        'NodeCloud',")
  out.push("        '');")
  out.push("FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));")
  out.push('ENDSEC;')
  out.push('DATA;')
  out.push('')

  // 最小限の宣言
  emit(`#10 = pre_defined_colour_feature(\\'black\\')`)
  emit(`#20 = pre_defined_font_feature(\\'continuous\\')`)
  emit(`#30 = width_feature('0.250000')`)

  // 1 本線: 座標はシート mm 直値 (sfig を通さないので scale=1)
  // (100,100) → (300,200) は A3 内に確実に収まる
  emit(`#40 = line_feature('1','1','1','3','100.000000','100.000000','300.000000','200.000000')`)

  // シート・レイヤ
  emit(`#50 = drawing_sheet_feature(\\'test\\','1','1','841','594')`)
  emit(`#60 = layer_feature(\\'test\\','1')`)

  out.push('ENDSEC;')
  out.push('END-ISO-10303-21;')
  return out.join('\r\n') + '\r\n'
}

// -------------------- テキスト用ヘルパー (CadExportPage と共通) --------------------

/** 頂点数字から測点名 (C / B{n} / A) を生成 */
function generatePointName(pipeNumber: string, idx: number, total: number): string {
  if (total <= 0) return pipeNumber
  if (idx === 0) return `${pipeNumber}C`
  if (idx === total - 1) return `${pipeNumber}A`
  const middleIndex = total - 1 - idx
  return `${pipeNumber}B${middleIndex}`
}

/** 管ID × 頂点インデックス → PlanPoint のルックアップ */
function buildPlanLookup(
  planGroups: PlanGroup[],
  pipes: PipeRow[],
): Map<string, Map<number, PlanPoint>> {
  const map = new Map<string, Map<number, PlanPoint>>()
  const EPS = 1e-4
  for (const group of planGroups) {
    for (const row of group.rows) {
      if (row.absorptionPipeId) {
        const pipe = pipes.find((p) => p.id === row.absorptionPipeId)
        if (pipe) {
          const inner = map.get(row.absorptionPipeId) ?? new Map<number, PlanPoint>()
          const limit = Math.min(row.absorptionPoints.length, pipe.vertices.length)
          for (let i = 0; i < limit; i++) {
            inner.set(i, row.absorptionPoints[i])
          }
          map.set(row.absorptionPipeId, inner)
        }
      }
      if (row.collectorPipeId && row.collectorPoint) {
        const pipe = pipes.find((p) => p.id === row.collectorPipeId)
        if (pipe) {
          const inner = map.get(row.collectorPipeId) ?? new Map<number, PlanPoint>()
          for (let i = 0; i < pipe.vertices.length; i++) {
            const v = pipe.vertices[i]
            if (
              Math.abs(v.x - row.collectorPoint.x) < EPS &&
              Math.abs(v.y - row.collectorPoint.y) < EPS
            ) {
              inner.set(i, row.collectorPoint)
              break
            }
          }
          map.set(row.collectorPipeId, inner)
        }
      }
    }
  }
  return map
}

/** 配線 (pipe) の中央 (路長の半分) 座標 + その位置での区間方向インデックス
 *  segIndex: 中点を含む区間 (v[segIndex] → v[segIndex+1]) の起点インデックス */
function pipeMidpoint(
  pipe: PipeRow,
): { x: number; y: number; segIndex: number } | null {
  const v = pipe.vertices
  if (v.length === 0) return null
  if (v.length === 1) return { x: v[0].x, y: v[0].y, segIndex: 0 }
  let total = 0
  const segLen: number[] = []
  for (let i = 1; i < v.length; i++) {
    const dx = v[i].x - v[i - 1].x
    const dy = v[i].y - v[i - 1].y
    const d = Math.sqrt(dx * dx + dy * dy)
    segLen.push(d)
    total += d
  }
  if (total === 0) return { x: v[0].x, y: v[0].y, segIndex: 0 }
  const target = total / 2
  let acc = 0
  for (let i = 0; i < segLen.length; i++) {
    if (acc + segLen[i] >= target) {
      const t = (target - acc) / segLen[i]
      return {
        x: v[i].x + t * (v[i + 1].x - v[i].x),
        y: v[i].y + t * (v[i + 1].y - v[i].y),
        segIndex: i,
      }
    }
    acc += segLen[i]
  }
  return { x: v[v.length - 1].x, y: v[v.length - 1].y, segIndex: segLen.length - 1 }
}

/** セグメントの角度を返す (rad)。文字が上下反転しないよう、
 *  常に (-π/2, π/2] の範囲に収める (180° を超えたら反対向きに補正)。 */
function calcTextAngle(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx)
  if (a > Math.PI / 2) a -= Math.PI
  else if (a <= -Math.PI / 2) a += Math.PI
  return a
}

function formatHeight(v: number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return v.toFixed(2)
}

/**
 * 生成した SFC の文字列を返す。呼び出し側で Shift-JIS 変換してファイルに書く。
 *
 * 座標変換:
 *  - 全 vertex の bbox を計算し、原点を (minX, minY) にシフト
 *  - 実 m → paper mm: real_meters * (1000 / scale)  (例: scale=1000 なら等値)
 *  - シート左下から margin (mm) 内側に配置
 *  - sfig_org / sfig_locate は使わず、全 feature を top-level に直接置く
 *    (ミニマル SFC が通ったので、余分な入れ子は避けて確実な構成にする)
 */
export function generateSfcPipesContent(
  pipes: PipeRow[],
  options: SfcExportOptions = {},
): string {
  const scale = options.scale ?? 1000
  const preserveSurvey = options.preserveSurveyCoords ?? false
  const rotationDeg = options.rotationDeg ?? 0
  // real_m → paper mm 変換係数 (paper-mode)
  const mToPaperMm = 1000 / scale // 1/1000 のときは 1
  const marginMm = 20
  const fileBase = options.fileBaseName ?? 'plan'
  const filename = `${fileBase}.sfc`
  const now = new Date()
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  // include フラグの解決 (default true)
  const inc = options.include ?? {}
  const incPipeShapes = inc.pipeShapes ?? true
  const incTransitions = inc.transitions ?? true
  const incPipeNumbers = inc.pipeNumbers ?? true
  const incPointNames = inc.pointNames ?? true
  const incGround = inc.groundHeight ?? true
  const incPlanned = inc.plannedHeight ?? true
  const incCutDepth = inc.cutDepth ?? true
  const incSlope = inc.segmentSlope ?? true
  const incDistance = inc.segmentDistance ?? true
  const incDiameter = inc.pipeDiameter ?? true

  const planGroups = options.planGroups ?? []
  const hasPlan = planGroups.length > 0
  // planGroups が無ければ全てのテキストは出力しない
  const emitPipeNumbers = incPipeNumbers && hasPlan
  const emitPointNames = incPointNames && hasPlan
  const emitGround = incGround && hasPlan
  const emitPlanned = incPlanned && hasPlan
  const emitCutDepth = incCutDepth && hasPlan
  const emitSlope = incSlope && hasPlan
  const emitDistance = incDistance && hasPlan
  const emitDiameter = incDiameter // 管径は pipe.diameter だけあれば出せるので Plan 不要
  const anyText =
    emitPipeNumbers ||
    emitPointNames ||
    emitGround ||
    emitPlanned ||
    emitCutDepth ||
    emitSlope ||
    emitDistance ||
    emitDiameter

  // 新規: ヘッダ / 追加要素 (方位マーク・基準点・工事区域) にも文字を使う
  const title = options.title ?? ''
  const projectName = options.projectName ?? ''
  const subtitle = options.subtitle ?? ''
  const showNorthArrow = options.showNorthArrow ?? false
  const refPoints = options.referencePoints ?? []
  const workAreasIn = options.workAreas ?? []
  const showReferenceTable = (options.showReferenceTable ?? false) && refPoints.length > 0
  const coordinateSystem = options.coordinateSystem ?? '2024'
  const emitTitle = !!title
  const emitHeaderInfo = !!projectName || !!subtitle
  const emitRefPoints = refPoints.length > 0
  const emitWorkAreas = workAreasIn.length > 0
  const needsTextFont =
    anyText ||
    emitTitle ||
    emitHeaderInfo ||
    showNorthArrow ||
    emitRefPoints ||
    emitWorkAreas

  const txt = options.textOptions ?? {}
  const moji = txt.moji ?? 2
  const pipeNumberSize = txt.pipeNumberSize ?? 2.5
  const absorptionStdDepth = txt.absorptionStdDepth ?? 0.8
  const collectorStdDepth = txt.collectorStdDepth ?? 0.9
  const cutDepthOnlyIfDiffFromStd = txt.cutDepthOnlyIfDiffFromStd ?? true

  // 全 vertex から bbox を求める (real m)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pipes) {
    for (const v of p.vertices) {
      if (v.x < minX) minX = v.x
      if (v.y < minY) minY = v.y
      if (v.x > maxX) maxX = v.x
      if (v.y > maxY) maxY = v.y
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 0; maxY = 0
  }

  // 用紙シート寸法 (mm) と、座標変換関数 toContent (survey-mode) / toPaper (paper-mode)
  let sheet: { width: number; height: number }
  let toContent: (x: number, y: number) => { cx: number; cy: number }
  let sfigTransform: { offsetX: number; offsetY: number } | null = null
  let sfMinXShared = 0
  let sfMinYShared = 0
  let paperMinXShared = 0 // paper-mode 用: swap 後の bbox 最小 (SFC 座標系)
  let paperMinYShared = 0
  // paper-mode 中央寄せ用: rx * mToPaperMm + paperOffsetX が最終用紙 px
  let paperOffsetX = 0
  let paperOffsetY = 0

  // survey-mode: SXF の sfig_locate 角度は (360 - user_deg) mod 360 に変換する
  const sxfAngleDeg = ((360 - rotationDeg) % 360 + 360) % 360
  const sxfAngleRad = (sxfAngleDeg * Math.PI) / 180

  if (preserveSurvey) {
    // PipeVertex は JGD2011 (x=北, y=東) だが SFC は (X=東, Y=北) の CAD 慣例。
    let sfMinX = Infinity, sfMinY = Infinity, sfMaxX = -Infinity, sfMaxY = -Infinity
    for (const p of pipes) {
      for (const v of p.vertices) {
        const sfx = v.y // 東
        const sfy = v.x // 北
        if (sfx < sfMinX) sfMinX = sfx
        if (sfy < sfMinY) sfMinY = sfy
        if (sfx > sfMaxX) sfMaxX = sfx
        if (sfy > sfMaxY) sfMaxY = sfy
      }
    }
    if (!Number.isFinite(sfMinX)) { sfMinX = 0; sfMinY = 0; sfMaxX = 0; sfMaxY = 0 }
    sfMinXShared = sfMinX
    sfMinYShared = sfMinY

    const sfOriginX = options.originY ?? sfMinX
    const sfOriginY = options.originX ?? sfMinY

    const cs = Math.cos(sxfAngleRad)
    const sn = Math.sin(sxfAngleRad)

    const corners: Array<[number, number]> = [
      [sfMinX - sfOriginX, sfMinY - sfOriginY],
      [sfMaxX - sfOriginX, sfMinY - sfOriginY],
      [sfMaxX - sfOriginX, sfMaxY - sfOriginY],
      [sfMinX - sfOriginX, sfMaxY - sfOriginY],
    ]
    let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity
    for (const [x, y] of corners) {
      const rx = cs * x - sn * y
      const ry = sn * x + cs * y
      if (rx < rMinX) rMinX = rx
      if (ry < rMinY) rMinY = ry
      if (rx > rMaxX) rMaxX = rx
      if (ry > rMaxY) rMaxY = ry
    }
    const contentW = (rMaxX - rMinX) * mToPaperMm + marginMm * 2
    const contentH = (rMaxY - rMinY) * mToPaperMm + marginMm * 2
    sheet = options.paperSize ? PAPER_SIZE_MM[options.paperSize] : pickSheet(contentW, contentH)

    const rotOriginX = cs * sfOriginX - sn * sfOriginY
    const rotOriginY = sn * sfOriginX + cs * sfOriginY
    // 中心寄せ: 図面の bbox 中央を 用紙 (図枠) の中央に合わせる
    const centeredOffsetX = sheet.width / 2 - ((rMinX + rMaxX) / 2) * mToPaperMm
    const centeredOffsetY = sheet.height / 2 - ((rMinY + rMaxY) / 2) * mToPaperMm
    sfigTransform = {
      offsetX: centeredOffsetX - rotOriginX * mToPaperMm,
      offsetY: centeredOffsetY - rotOriginY * mToPaperMm,
    }
    toContent = (x, y) => ({ cx: y * 1000, cy: x * 1000 })
  } else {
    // paper-mode: SFC 座標系 (X=東=v.y, Y=北=v.x) に swap した上で、
    // 必要なら回転をかけて bbox を取り直す。
    // 回転は survey-mode と同じ sxfAngleDeg (= 360 - user_deg) を CCW で適用。
    const cs = Math.cos(sxfAngleRad)
    const sn = Math.sin(sxfAngleRad)
    let sfMinX = Infinity, sfMinY = Infinity, sfMaxX = -Infinity, sfMaxY = -Infinity
    for (const p of pipes) {
      for (const v of p.vertices) {
        const sfx = v.y
        const sfy = v.x
        const rx = cs * sfx - sn * sfy
        const ry = sn * sfx + cs * sfy
        if (rx < sfMinX) sfMinX = rx
        if (ry < sfMinY) sfMinY = ry
        if (rx > sfMaxX) sfMaxX = rx
        if (ry > sfMaxY) sfMaxY = ry
      }
    }
    if (!Number.isFinite(sfMinX)) { sfMinX = 0; sfMinY = 0; sfMaxX = 0; sfMaxY = 0 }
    paperMinXShared = sfMinX
    paperMinYShared = sfMinY
    const contentW = (sfMaxX - sfMinX) * mToPaperMm + marginMm * 2
    const contentH = (sfMaxY - sfMinY) * mToPaperMm + marginMm * 2
    sheet = options.paperSize ? PAPER_SIZE_MM[options.paperSize] : pickSheet(contentW, contentH)
    // 中心寄せ: 図面の bbox 中央を 用紙 (図枠) の中央に合わせる
    paperOffsetX = sheet.width / 2 - ((sfMinX + sfMaxX) / 2) * mToPaperMm
    paperOffsetY = sheet.height / 2 - ((sfMinY + sfMaxY) / 2) * mToPaperMm
    toContent = (x, y) => {
      const sfx = y
      const sfy = x
      const rx = cs * sfx - sn * sfy
      const ry = sn * sfx + cs * sfy
      return {
        cx: rx * mToPaperMm + paperOffsetX,
        cy: ry * mToPaperMm + paperOffsetY,
      }
    }
    // 使用しない (survey-only 変数) の警告避け
    void minX; void minY; void maxX; void maxY
  }

  /**
   * 実座標 (x=北, y=東) → 用紙 mm (SFC 座標系: X=東, Y=北 に swap 済み)
   * テキスト出力用。sfig の外に置くため、survey-mode でも paper-mode でも
   * 最終的な用紙 mm を返す。
   */
  const realToPaperMm = (x: number, y: number): { px: number; py: number } => {
    const sfx = y
    const sfy = x
    const cs = Math.cos(sxfAngleRad)
    const sn = Math.sin(sxfAngleRad)
    if (preserveSurvey && sfigTransform) {
      const px = sfigTransform.offsetX + (cs * sfx - sn * sfy) * mToPaperMm
      const py = sfigTransform.offsetY + (sn * sfx + cs * sfy) * mToPaperMm
      return { px, py }
    }
    // paper-mode: swap → 回転 → 中央寄せオフセット
    const rx = cs * sfx - sn * sfy
    const ry = sn * sfx + cs * sfy
    return {
      px: rx * mToPaperMm + paperOffsetX,
      py: ry * mToPaperMm + paperOffsetY,
    }
  }
  // survey-only 内部変数の unused 警告防止
  void sfMinXShared; void sfMinYShared; void paperMinXShared; void paperMinYShared

  const out: string[] = []
  let nextIdCounter = 10
  const nextId = () => {
    const v = nextIdCounter
    nextIdCounter += 10
    return v
  }
  const emit = (body: string) => {
    out.push('/*SXF')
    out.push(body)
    out.push('SXF*/')
    out.push('')
  }

  // ===== HEADER =====
  out.push('ISO-10303-21;')
  out.push('HEADER;')
  out.push("FILE_DESCRIPTION(('SCADEC level2 feature_mode'),")
  out.push("        '2;1');")
  out.push(`FILE_NAME('${filename}',`)
  out.push(`        '${iso}',`)
  out.push("        (''),")
  out.push("        (''),")
  out.push("        'SCADEC_API_Ver3.30$$3.1',")
  out.push("        'NodeCloud',")
  out.push("        '');")
  out.push("FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));")
  out.push('ENDSEC;')
  out.push('DATA;')
  out.push('')

  // ===== 色 / フォント / 線幅 (SXF 標準を "使う" 宣言) =====
  for (const c of DECLARED_COLORS) {
    emit(`#${nextId()} = pre_defined_colour_feature(\\'${c}\\')`)
  }
  emit(`#${nextId()} = pre_defined_font_feature(\\'continuous\\')`)
  emit(`#${nextId()} = pre_defined_font_feature(\\'dashed\\')`)
  emit(`#${nextId()} = width_feature('0.250000')`)
  emit(`#${nextId()} = width_feature('0.350000')`)

  // テキストフォント (使う場合のみ宣言)
  const TEXT_FONT_IDX = 1 // 最初の text_font_feature が 1
  if (needsTextFont) {
    emit(`#${nextId()} = text_font_feature(\\'ＭＳ ゴシック\\')`)
  }

  // ===== survey-mode: 背景色 sfig を開く =====
  const bgFigName = '$$ATRU$$1$$背景色$$色$$0_0_0'
  const level2FigName = '名称未定'
  if (preserveSurvey) {
    emit(`#${nextId()} = sfig_org_feature(\\'${bgFigName}\\','3')`)
  }

  // ===== 配線を管種ごとにグループ化 =====
  const byType = new Map<PipeType | 'unknown', PipeRow[]>()
  for (const p of pipes) {
    const key = (p.pipeType ?? 'unknown') as PipeType | 'unknown'
    const arr = byType.get(key) ?? []
    arr.push(p)
    byType.set(key, arr)
  }

  const layerNames: string[] = []
  let layerIdx = 0
  const pipeTypeOrder: Array<PipeType | 'unknown'> = [
    'main',
    'branch',
    'outlet',
    'connection',
    'spring',
    'auxiliary',
    'self_funded',
    'unknown',
  ]

  if (incPipeShapes) {
    for (const pt of pipeTypeOrder) {
      const group = byType.get(pt)
      if (!group || group.length === 0) continue
      layerIdx += 1
      const label = pt === 'unknown' ? '未分類' : PIPE_TYPE_NAMES[pt as PipeType] ?? String(pt)
      layerNames.push(label)
      const colorName = PIPE_TYPE_COLOR[pt as string] ?? 'green'
      const colorCode = COLOR_CODE[colorName]
      const widthCode = pt === 'main' ? WIDTH_035 : WIDTH_025
      const fontCode = fontForPipeType(pt as string)

      for (const pipe of group) {
        const vs = pipe.vertices
        if (vs.length < 2) continue
        const points = vs.map((v) => toContent(v.x, v.y))
        if (points.length === 2) {
          const [a, b] = points
          emit(
            `#${nextId()} = line_feature('${layerIdx}','${colorCode}','${fontCode}','${widthCode}','${a.cx.toFixed(6)}','${a.cy.toFixed(6)}','${b.cx.toFixed(6)}','${b.cy.toFixed(6)}')`,
          )
        } else {
          const xs = points.map((p) => p.cx.toFixed(6)).join(',')
          const ys = points.map((p) => p.cy.toFixed(6)).join(',')
          emit(
            `#${nextId()} = polyline_feature('${layerIdx}','${colorCode}','${fontCode}','${widthCode}','${points.length}','(${xs})','(${ys})')`,
          )
        }
      }
    }
  }

  // ===== 管種切替点の 1mm 円 =====
  if (incTransitions) {
    const transitions = findTransitionPoints(pipes)
    if (transitions.length > 0) {
      layerIdx += 1
      layerNames.push('記号')
      const radiusStr = (preserveSurvey ? scale : 1).toFixed(6)
      for (const t of transitions) {
        const { cx, cy } = toContent(t.x, t.y)
        emit(
          `#${nextId()} = circle_feature('${layerIdx}','${COLOR_CODE.yellow}','${FONT_CONTINUOUS}','${WIDTH_025}','${cx.toFixed(6)}','${cy.toFixed(6)}','${radiusStr}')`,
        )
      }
    }
  }

  // ===== survey-mode: level-2 マーカー sfig + 2 つの sfig_locate =====
  if (preserveSurvey && sfigTransform) {
    emit(`#${nextId()} = sfig_org_feature(\\'${level2FigName}\\','2')`)
    const s = (1 / scale).toFixed(14)
    emit(
      `#${nextId()} = sfig_locate_feature('0',\\'${level2FigName}\\','${sfigTransform.offsetX.toFixed(6)}','${sfigTransform.offsetY.toFixed(6)}','${sxfAngleDeg.toFixed(12)}','${s}','${s}')`,
    )
    emit(
      `#${nextId()} = sfig_locate_feature('0',\\'${bgFigName}\\','0.000000','0.000000','0.00000000000000','1.00000000000000','1.00000000000000')`,
    )
    const daId = nextId()
    out.push('/*SXF3')
    out.push(`#${daId} = drawing_attribute_feature(\\' \\',\\' \\',\\' \\',\\' \\',\\' \\',\\' \\',\\' \\','0','1','1',\\' \\',\\' \\')`)
    out.push('SXF3*/')
    out.push('')
  }

  // ===== テキスト要素 (常に 用紙 mm、top-level) =====
  //
  // レイヤ順序 (実装容易性優先で、使われるものだけを登録):
  //   1) 配線番号
  //   2) 吸水: 測点/地盤高/計画高/切深/勾配/延長
  //   3) 集水: 測点/地盤高/計画高/切深/勾配/延長
  // レイヤ番号は 配線・記号レイヤの続きから連番。
  const textLayerIndex: Partial<{
    pipeNumber: number
    absPoint: number
    absGround: number
    absPlanned: number
    absCut: number
    absSlope: number
    absDist: number
    absDiameter: number
    colPoint: number
    colGround: number
    colPlanned: number
    colCut: number
    colSlope: number
    colDist: number
    colDiameter: number
  }> = {}
  const registerTextLayer = (name: string): number => {
    layerIdx += 1
    layerNames.push(name)
    return layerIdx
  }

  if (anyText) {
    if (emitPipeNumbers) textLayerIndex.pipeNumber = registerTextLayer('配線番号')
    if (emitPointNames) textLayerIndex.absPoint = registerTextLayer('吸水測点')
    if (emitGround) textLayerIndex.absGround = registerTextLayer('吸水地盤高')
    if (emitPlanned) textLayerIndex.absPlanned = registerTextLayer('吸水計画高')
    if (emitCutDepth) textLayerIndex.absCut = registerTextLayer('吸水切深')
    if (emitSlope) textLayerIndex.absSlope = registerTextLayer('吸水勾配')
    if (emitDistance) textLayerIndex.absDist = registerTextLayer('吸水延長')
    if (emitDiameter) textLayerIndex.absDiameter = registerTextLayer('吸水管径')
    if (emitPointNames) textLayerIndex.colPoint = registerTextLayer('集水測点')
    if (emitGround) textLayerIndex.colGround = registerTextLayer('集水地盤高')
    if (emitPlanned) textLayerIndex.colPlanned = registerTextLayer('集水計画高')
    if (emitCutDepth) textLayerIndex.colCut = registerTextLayer('集水切深')
    if (emitSlope) textLayerIndex.colSlope = registerTextLayer('集水勾配')
    if (emitDistance) textLayerIndex.colDist = registerTextLayer('集水延長')
    if (emitDiameter) textLayerIndex.colDiameter = registerTextLayer('集水管径')
  }

  /** text_string_feature を出力。
   *  SXF の text width は文字列の 全幅 (mm) を渡す仕様。
   *  半角 = 文字高/2、全角 = 文字高 で 1 文字ずつ加算する。 */
  const emitText = (
    layer: number,
    color: number,
    text: string,
    px: number,
    py: number,
    height: number,
    angleRad: number,
    basePoint = 1,
  ) => {
    if (!text) return
    // SFC は角度を [0, 360) の正値で受ける実装が多いので正規化
    const rawDeg = (angleRad * 180) / Math.PI
    const angleDeg = ((rawDeg % 360) + 360) % 360
    const width = height * textWidthUnits(text)
    const escaped = escapeSfcString(text)
    emit(
      `#${nextId()} = text_string_feature('${layer}','${color}','${TEXT_FONT_IDX}',\\'${escaped}\\','${px.toFixed(6)}','${py.toFixed(6)}','${height.toFixed(6)}','${width.toFixed(6)}','0.000000','${angleDeg.toFixed(12)}','0.00000000000000','${basePoint}','1')`,
    )
  }

  if (anyText) {
    const planLookup = buildPlanLookup(planGroups, pipes)
    // テキスト step: 上→下に積むため、paper Y は下方向マイナスとみなさず
    // "y を減らす" 方向で積む (TrendOne の buildTextLines は +cos で積んでいたが
    // それは TrendOne 独自座標系。SFC は +Y=上なので、下に並べる = -Y。)
    const stepDx = 0
    const stepDy = -moji * 1.05

    // 同一 vertex 位置に複数配線 (吸水+集水) が来た場合の重複回避。
    // paper 座標 (0.5mm 単位でキー化) ごとに 何回目の text 群かをカウントし、
    // 2 回目以降は 右方向にずらして描画する。
    const groupPosKey = (px: number, py: number) =>
      `${Math.round(px * 2)}_${Math.round(py * 2)}`
    const groupCount = new Map<string, number>()
    const groupShiftPerOccurrence = moji * 3

    // 集水頂点の重複除去 + planLookup 不一致時のフォールバック用に
    // 座標ベース (100mm 単位=位置一致に寛容) のマップを作る:
    //   ・collectorPlanByPos: (x,y) → 最初の PlanPoint (S4A S3C 等の統合名を含む)
    //   ・collectorSkip: (pipeId|idx) の集合。同じ位置に既に頂点があれば skip
    const POS_KEY_M = 10 // 100mm 精度 (座標微差に寛容)
    const realPosKey = (x: number, y: number) =>
      `${Math.round(x * POS_KEY_M)}_${Math.round(y * POS_KEY_M)}`
    const collectorPlanByPos = new Map<string, PlanPoint>()
    for (const group of planGroups) {
      if (group.groupType !== 'collector' && group.groupType !== 'direct') continue
      for (const row of group.rows) {
        if (!row.collectorPoint) continue
        const k = realPosKey(row.collectorPoint.x, row.collectorPoint.y)
        if (!collectorPlanByPos.has(k)) {
          collectorPlanByPos.set(k, row.collectorPoint)
        }
      }
    }
    // Plan pointName → PlanPoint の辞書 (座標マッチが失敗した時の名前フォールバック)
    // "S4A S3C" のような統合名の各トークンも同じ PlanPoint に紐付けておく。
    const collectorPlanByName = new Map<string, PlanPoint>()
    for (const [, cp] of collectorPlanByPos) {
      const name = cp.pointName || ''
      if (!name) continue
      if (!collectorPlanByName.has(name)) collectorPlanByName.set(name, cp)
      for (const t of name.split(/[.\s]+/).filter((s) => s.length > 0)) {
        if (!collectorPlanByName.has(t)) collectorPlanByName.set(t, cp)
      }
    }
    // 集水 dedup 用のキーは 10mm 精度 (Plan 検索の 100mm より厳格)。
    // 100mm だと近い頂点まで巻き込んで消してしまう副作用があるため、
    // "ほぼ同一位置" と言える 10mm 以内の場合のみ 2 本目を skip する。
    const DEDUP_KEY_M = 100
    const dedupPosKey = (x: number, y: number) =>
      `${Math.round(x * DEDUP_KEY_M)}_${Math.round(y * DEDUP_KEY_M)}`
    const collectorVertexList = new Map<string, string[]>()
    for (const pipe of pipes) {
      if (pipe.pipeType === 'branch') continue
      for (let i = 0; i < pipe.vertices.length; i++) {
        const v = pipe.vertices[i]
        const k = dedupPosKey(v.x, v.y)
        const list = collectorVertexList.get(k) ?? []
        list.push(`${pipe.id}|${i}`)
        collectorVertexList.set(k, list)
      }
    }
    const collectorSkip = new Set<string>()
    for (const [, list] of collectorVertexList) {
      for (let j = 1; j < list.length; j++) collectorSkip.add(list[j])
    }

    // 吸水を先に処理する (集水が同位置なら shift される)
    const orderedPipes = [
      ...pipes.filter((p) => p.pipeType === 'branch'),
      ...pipes.filter((p) => p.pipeType !== 'branch'),
    ]

    for (const pipe of orderedPipes) {
      if (pipe.vertices.length === 0) continue
      const isAbsorption = pipe.pipeType === 'branch'
      const layers = isAbsorption
        ? {
            point: textLayerIndex.absPoint,
            ground: textLayerIndex.absGround,
            plan: textLayerIndex.absPlanned,
            depth: textLayerIndex.absCut,
            slope: textLayerIndex.absSlope,
            dist: textLayerIndex.absDist,
            diameter: textLayerIndex.absDiameter,
            planColor: COLOR_CODE.red,
            depthColor: COLOR_CODE.blue,
          }
        : {
            point: textLayerIndex.colPoint,
            ground: textLayerIndex.colGround,
            plan: textLayerIndex.colPlanned,
            depth: textLayerIndex.colCut,
            slope: textLayerIndex.colSlope,
            dist: textLayerIndex.colDist,
            diameter: textLayerIndex.colDiameter,
            planColor: COLOR_CODE.magenta,
            depthColor: COLOR_CODE.cyan,
          }
      const stdDepth = isAbsorption ? absorptionStdDepth : collectorStdDepth
      const initialYOffset = isAbsorption ? moji * 0.5 : moji * 1.5

      const planForPipe = planLookup.get(pipe.id) ?? null
      const total = pipe.vertices.length

      for (let i = 0; i < total; i++) {
        const v = pipe.vertices[i]
        // 集水は同座標に複数配線がある (S4A と S3C が同じ点) 場合、
        // 最初の 1 本だけを描画。2 本目以降は collectorSkip でスキップ。
        if (!isAbsorption && collectorSkip.has(`${pipe.id}|${i}`)) continue

        // 集水の plan を検索: (1) planForPipe (2) 座標フォールバック (3) 名称フォールバック
        // (1) は buildPlanLookup の per-pipe 索引 (EPS=1e-4 で座標一致)
        // (2) は 100mm 精度の座標キーで探す (S5C 等が微差で拾えないケース対応)
        // (3) は auto-name (S5C, K7B 等) を Plan の pointName トークンで検索
        //     ("S4A S3C" の "S4A" にヒットする)
        let pp: PlanPoint | null = planForPipe?.get(i) ?? null
        if (!pp && !isAbsorption) {
          pp = collectorPlanByPos.get(realPosKey(v.x, v.y)) ?? null
          if (!pp) {
            const autoName = generatePointName(pipe.number, i, pipe.vertices.length)
            pp = collectorPlanByName.get(autoName) ?? null
          }
        }

        // 集水で plan マッチが取れず、頂点にも標高データが無い場合は
        // 描画不能の "phantom" 頂点。0.00 と表示されるだけなので skip する。
        if (!isAbsorption && !pp) {
          const vz = v.z
          if (vz === null || vz === undefined || vz === 0) continue
        }
        const { px: x1, py: y1 } = realToPaperMm(v.x, v.y)

        // 前頂点方向 (勾配・距離ラベル用)
        let segAngle = 0
        let midX = x1
        let midY = y1
        if (i > 0) {
          const prev = pipe.vertices[i - 1]
          const prevP = realToPaperMm(prev.x, prev.y)
          const dx = prevP.px - x1
          const dy = prevP.py - y1
          segAngle = calcTextAngle(dx, dy)
          midX = (x1 + prevP.px) / 2
          midY = (y1 + prevP.py) / 2
        }

        const pointName =
          pp !== null ? pp.pointName : generatePointName(pipe.number, i, total)
        const gh = pp?.groundHeight ?? v.z ?? null
        const ph = pp?.plannedHeight ?? null
        const cd = pp?.cutDepth ?? (gh !== null && ph !== null ? gh - ph : null)
        const ghStr = formatHeight(gh)
        const fhStr = formatHeight(ph)
        const chStr = formatHeight(cd)

        // 距離・勾配
        let slopeLabel: string | null = null
        let distLabel: string | null = null
        if (i > 0) {
          const prev = pipe.vertices[i - 1]
          const prevPP = planForPipe?.get(i - 1) ?? null
          const prevPh = prevPP?.plannedHeight ?? null
          const dist = Math.sqrt(
            (v.x - prev.x) * (v.x - prev.x) + (v.y - prev.y) * (v.y - prev.y),
          )
          if (dist > 0) {
            distLabel = `(${dist.toFixed(1)})`
          }
          if (ph !== null && prevPh !== null && dist > 0 && prevPh !== ph) {
            slopeLabel = `1/${Math.round(dist / Math.abs(prevPh - ph))}`
          }
        }

        // 同位置に既に text 群が置かれていれば右方向へずらす
        const posKey = groupPosKey(x1, y1)
        const occurrence = groupCount.get(posKey) ?? 0
        groupCount.set(posKey, occurrence + 1)
        const shiftX = occurrence * groupShiftPerOccurrence

        // 頂点周りに縦積み
        let cx = x1 + shiftX
        let cy = y1 + initialYOffset
        if (emitPointNames && layers.point) {
          emitText(layers.point, COLOR_CODE.black, pointName, cx, cy, moji, 0, 1)
        }
        cx += stepDx; cy += stepDy
        if (emitGround && layers.ground && ghStr) {
          emitText(layers.ground, COLOR_CODE.black, ghStr, cx, cy, moji, 0, 1)
        }
        cx += stepDx; cy += stepDy
        if (emitPlanned && layers.plan && fhStr) {
          emitText(layers.plan, layers.planColor, fhStr, cx, cy, moji, 0, 1)
        }
        cx += stepDx; cy += stepDy
        if (
          emitCutDepth &&
          layers.depth &&
          cd !== null &&
          (!cutDepthOnlyIfDiffFromStd || Math.abs(cd - stdDepth) > 0.005)
        ) {
          emitText(layers.depth, layers.depthColor, chStr, cx, cy, moji, 0, 1)
        }

        // セグメント中点: 勾配 (上側) / 距離 (下側) / 管径 (下 2 段目) を
        // 配線方向に平行に配置。paper Y ではなく "配線方向の垂直" に
        // ずらすことで、配線が回転していても文字が重ならない。
        //   perp = (-sin(θ), cos(θ)): 配線方向 θ に対して 90° 反時計 (上向き)
        if (isAbsorption) {
          const perpX = -Math.sin(segAngle)
          const perpY = Math.cos(segAngle)
          if (emitSlope && layers.slope && slopeLabel) {
            // 配線より少し上 (perp +0.1 の位置に anchor)、base_point=2 (中下) で上方向へ描画
            emitText(
              layers.slope,
              COLOR_CODE.green,
              slopeLabel,
              midX + perpX * moji * 0.1,
              midY + perpY * moji * 0.1,
              moji,
              segAngle,
              2,
            )
          }
          if (emitDistance && layers.dist && distLabel) {
            // 配線より少し下 (perp -0.1)、base_point=8 (中上) で下方向へ描画
            emitText(
              layers.dist,
              COLOR_CODE.black,
              distLabel,
              midX + perpX * -moji * 0.1,
              midY + perpY * -moji * 0.1,
              moji,
              segAngle,
              8,
            )
          }
        }
        // 管径 (吸水): 区間距離のさらに下段
        if (
          isAbsorption &&
          emitDiameter &&
          layers.diameter &&
          i > 0 &&
          pipe.diameter != null
        ) {
          const perpX = -Math.sin(segAngle)
          const perpY = Math.cos(segAngle)
          const segDia = pp?.segmentDiameter ?? pipe.diameter
          emitText(
            layers.diameter,
            COLOR_CODE.black,
            `φ${segDia}`,
            midX + perpX * -moji * 1.2,
            midY + perpY * -moji * 1.2,
            moji,
            segAngle,
            8,
          )
        }
      }

      // 配線番号: 中点を含む区間方向 (配線方向) に平行、
      //  基準位置 (中点) から 配線方向 逆向き (=左) + 垂直方向 (=上)
      //  へずらして描画。base_point=5 (中中) で中心アンカー、
      //  囲み円 (φ4mm) も同じ位置に描く。
      if (emitPipeNumbers && textLayerIndex.pipeNumber && pipe.number) {
        const mid = pipeMidpoint(pipe)
        if (mid) {
          const { px, py } = realToPaperMm(mid.x, mid.y)
          // 配線方向 (中点を含む区間) を計算
          let pipeAngle = 0
          const vs = pipe.vertices
          if (vs.length >= 2 && mid.segIndex < vs.length - 1) {
            const a = realToPaperMm(vs[mid.segIndex].x, vs[mid.segIndex].y)
            const b = realToPaperMm(
              vs[mid.segIndex + 1].x,
              vs[mid.segIndex + 1].y,
            )
            pipeAngle = calcTextAngle(b.px - a.px, b.py - a.py)
          }
          // 配線方向 (正=前方) の単位ベクトル / 垂直 (上向き)
          const cs = Math.cos(pipeAngle)
          const sn = Math.sin(pipeAngle)
          const shiftAlong = pipeNumberSize * 3.5 // 中点から 左 (配線逆方向) へ
          const shiftPerp = pipeNumberSize * 1.5 // 上 (垂直方向) へ
          const tx = px - cs * shiftAlong + -sn * shiftPerp
          const ty = py - sn * shiftAlong + cs * shiftPerp
          emitText(
            textLayerIndex.pipeNumber,
            COLOR_CODE.black,
            pipe.number,
            tx,
            ty,
            pipeNumberSize,
            pipeAngle,
            5, // base_point 5 = 中中 → text 中心が (tx, ty)
          )
          // 直径 4mm = 半径 2mm の円で 配線番号 と同位置に配置
          emit(
            `#${nextId()} = circle_feature('${textLayerIndex.pipeNumber}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_025}','${tx.toFixed(6)}','${ty.toFixed(6)}','2.000000')`,
          )
        }
      }
    }

    // ===== 集水 合流点の 計画高 補完 (施工計画から直接生成) =====
    // pipe.vertices と Plan の座標が一致しない 合流点 (K14→S4 等の入力位置)
    // では pipe ループで plan.collectorPoint を拾えず、計画高が全く出力
    // されない。ここで補完する。要素は 計画高 のみ (点名・地盤高は不要)。
    if (emitPlanned && textLayerIndex.colPlanned && hasPlan) {
      // どの Plan collectorPoint が pipe ループで既に描画済みか判定するため、
      // 集水 pipe の全頂点座標を Set 化
      const collectorVertexPositions = new Set<string>()
      for (const pipe of pipes) {
        if (pipe.pipeType === 'branch') continue
        for (const v of pipe.vertices) {
          collectorVertexPositions.add(realPosKey(v.x, v.y))
        }
      }
      for (const group of planGroups) {
        if (group.groupType !== 'collector' && group.groupType !== 'direct') continue
        for (const row of group.rows) {
          const cp = row.collectorPoint
          if (!cp) continue
          if (cp.plannedHeight === null || cp.plannedHeight === undefined) continue
          // 既に pipe vertex ループで描画済みならスキップ
          if (collectorVertexPositions.has(realPosKey(cp.x, cp.y))) continue

          const { px, py } = realToPaperMm(cp.x, cp.y)
          // 吸水と重なるので右にずらす (吸水と同じ shift ロジック)
          const posKey = groupPosKey(px, py)
          const occurrence = groupCount.get(posKey) ?? 0
          groupCount.set(posKey, occurrence + 1)
          const shiftX = occurrence * groupShiftPerOccurrence
          // 集水スタック位置 (initialYOffset は 1.5*moji、その下 2 段目 = 計画高)
          const cy = py + moji * 1.5 + stepDy * 2 // 点名(1) + 地盤高(2) 分だけ下げる
          emitText(
            textLayerIndex.colPlanned,
            COLOR_CODE.magenta,
            formatHeight(cp.plannedHeight),
            px + shiftX,
            cy,
            moji,
            0,
            1,
          )
        }
      }
    }

    // ===== 集水勾配 + 集水距離 (施工計画から直接生成) =====
    // 施工計画表の 集水 区間勾配 列 (右端列) と同じロジック:
    //   - segmentDistance は row.collectorPoint.segmentDistance (Plan の値)
    //   - manualSlope があればそれを、無ければ (dist / |ph差|) を採用
    if (emitSlope || emitDistance) {
      for (const group of planGroups) {
        if (group.groupType !== 'collector' && group.groupType !== 'direct') continue
        for (let r = 0; r < group.rows.length - 1; r++) {
          const row = group.rows[r]
          const nextRow = group.rows[r + 1]
          const cp = row.collectorPoint
          const nextCp = nextRow.collectorPoint
          if (!cp || !nextCp) continue
          const dist = cp.segmentDistance
          if (!dist || dist <= 0) continue

          // 勾配: manualSlope 優先、無ければ計画高差から計算
          let slopeLabel: string | null = null
          if (cp.manualSlope) {
            slopeLabel = cp.manualSlope
          } else {
            const ph1 = cp.plannedHeight
            const ph2 = nextCp.plannedHeight
            if (ph1 !== null && ph2 !== null && ph1 !== ph2) {
              slopeLabel = `1/${Math.round(Math.abs(dist / (ph1 - ph2)))}`
            }
          }

          // 中点 (paper) と方向は 幾何座標から
          const p1 = realToPaperMm(cp.x, cp.y)
          const p2 = realToPaperMm(nextCp.x, nextCp.y)
          const midX = (p1.px + p2.px) / 2
          const midY = (p1.py + p2.py) / 2
          const segAngle = calcTextAngle(p2.px - p1.px, p2.py - p1.py)
          const perpX = -Math.sin(segAngle)
          const perpY = Math.cos(segAngle)

          if (emitSlope && slopeLabel && textLayerIndex.colSlope) {
            emitText(
              textLayerIndex.colSlope,
              COLOR_CODE.green,
              slopeLabel,
              midX + perpX * moji * 0.1,
              midY + perpY * moji * 0.1,
              moji,
              segAngle,
              2,
            )
          }
          if (emitDistance && textLayerIndex.colDist) {
            emitText(
              textLayerIndex.colDist,
              COLOR_CODE.black,
              `(${dist.toFixed(1)})`,
              midX + perpX * -moji * 0.1,
              midY + perpY * -moji * 0.1,
              moji,
              segAngle,
              8,
            )
          }
          // 集水 管径 (row.collectorPoint.segmentDiameter を優先、無ければ pipe.diameter)
          if (emitDiameter && textLayerIndex.colDiameter) {
            const collectorPipe = row.collectorPipeId
              ? pipes.find((p) => p.id === row.collectorPipeId)
              : null
            const segDia = cp.segmentDiameter ?? collectorPipe?.diameter ?? null
            if (segDia != null) {
              emitText(
                textLayerIndex.colDiameter,
                COLOR_CODE.black,
                `φ${segDia}`,
                midX + perpX * -moji * 1.2,
                midY + perpY * -moji * 1.2,
                moji,
                segAngle,
                8,
              )
            }
          }
        }
      }
    }
  }

  // ===== 追加要素: 基準点 / 工事区域 (実座標系 = realToPaperMm で配置) =====
  if (emitRefPoints) {
    const refLayer = registerTextLayer('基準点')
    // radius/text は用紙 mm。survey-mode の circle は sfig 縮尺の影響を受けるが、
    // 追加要素は sfig の外 (top-level) に置くため 用紙 mm 直値でよい。
    const refRadiusMm = 0.5
    for (const rp of refPoints) {
      const { px, py } = realToPaperMm(rp.x, rp.y)
      emit(
        `#${nextId()} = circle_feature('${refLayer}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_025}','${px.toFixed(6)}','${py.toFixed(6)}','${refRadiusMm.toFixed(6)}')`,
      )
      // ラベル: 右上に少しオフセット
      emitText(
        refLayer,
        COLOR_CODE.black,
        rp.label,
        px + 1.0,
        py + 1.0,
        2,
        0,
        1,
      )
    }
  }

  if (emitWorkAreas) {
    const areaLayer = registerTextLayer('工事区域')
    const areaLabelLayer = registerTextLayer('工事区域点名')
    for (const wa of workAreasIn) {
      if (wa.points.length < 2) continue
      // 閉じたポリライン (最初の頂点を末尾に追加)
      const closed = [...wa.points, wa.points[0]]
      const paperPts = closed.map((p) => realToPaperMm(p.x, p.y))
      const xs = paperPts.map((p) => p.px.toFixed(6)).join(',')
      const ys = paperPts.map((p) => p.py.toFixed(6)).join(',')
      emit(
        `#${nextId()} = polyline_feature('${areaLayer}','${COLOR_CODE.green}','${FONT_CONTINUOUS}','${WIDTH_025}','${paperPts.length}','(${xs})','(${ys})')`,
      )
      // 頂点ラベル (点名) — 右上オフセット
      for (const p of wa.points) {
        const { px, py } = realToPaperMm(p.x, p.y)
        emitText(
          areaLabelLayer,
          COLOR_CODE.black,
          p.label,
          px + 1.0,
          py + 1.0,
          2,
          0,
          1,
        )
      }
    }
  }

  // ===== 追加要素: 図面ヘッダ (タイトル・現場名・工区名) / 方位マーク =====
  // これらは "用紙上の絶対位置" (実座標に無関係) で配置する。sheet 全体基準。

  // 図枠: 用紙の外周から一定距離オフセットした矩形。
  // A0/A1 は 20mm、A2/A3 は 10mm オフセット。
  {
    const paperMax = Math.max(sheet.width, sheet.height)
    const frameInset = paperMax >= 800 ? 20 : 10 // A0(1189)/A1(841) → 20, A2(594)/A3(420) → 10
    const frameLayer = registerTextLayer('図枠')
    const fx = [
      frameInset,
      sheet.width - frameInset,
      sheet.width - frameInset,
      frameInset,
      frameInset,
    ]
      .map((v) => v.toFixed(6))
      .join(',')
    const fy = [
      frameInset,
      frameInset,
      sheet.height - frameInset,
      sheet.height - frameInset,
      frameInset,
    ]
      .map((v) => v.toFixed(6))
      .join(',')
    emit(
      `#${nextId()} = polyline_feature('${frameLayer}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_035}','5','(${fx})','(${fy})')`,
    )
  }

  // 図面ヘッダ (タイトル・現場名・工区名) は 全て 7mm・左寄せ で上から積む。
  // 左端 = 図枠左辺 + 5mm、上端 = 図枠上辺 - 10mm (最初のテキストのベースライン)
  {
    const paperMax = Math.max(sheet.width, sheet.height)
    const frameInset = paperMax >= 800 ? 20 : 10
    const headerHeight = 7
    const lineGap = headerHeight * 1.4 // 行間 (テキスト高 × 1.4)
    const headerX = frameInset + 5
    let headerY = sheet.height - frameInset - headerHeight - 3
    const headerLayer =
      emitTitle || emitHeaderInfo ? registerTextLayer('図面ヘッダ') : -1
    if (emitTitle && headerLayer > 0) {
      emitText(headerLayer, COLOR_CODE.black, title, headerX, headerY, headerHeight, 0, 1)
      headerY -= lineGap
    }
    if (emitHeaderInfo && headerLayer > 0) {
      if (projectName) {
        emitText(headerLayer, COLOR_CODE.black, projectName, headerX, headerY, headerHeight, 0, 1)
        headerY -= lineGap
      }
      if (subtitle) {
        emitText(headerLayer, COLOR_CODE.black, subtitle, headerX, headerY, headerHeight, 0, 1)
        headerY -= lineGap
      }
    }
  }
  if (showNorthArrow) {
    const northLayer = registerTextLayer('方位マーク')
    // 中心: 上端右 (sheet.width - 30, sheet.height - 30)
    const cx = sheet.width - 30
    const cy = sheet.height - 30
    // 「real の北」= 実座標 x=+方向。SFC 座標系では swap 後 (X=東=y, Y=北=x) の Y+ 方向。
    // 回転後の "up (北)" 方向: (upX, upY) = (-sin θ, cos θ)
    const upX = -Math.sin(sxfAngleRad)
    const upY = Math.cos(sxfAngleRad)
    // "right" は up を CW 90° 回転: (rightX, rightY) = (cos θ, sin θ)
    const rightX = Math.cos(sxfAngleRad)
    const rightY = Math.sin(sxfAngleRad)
    // 局所座標 (u=右+, v=上+, mm) → 用紙 (px, py)
    const toPaper = (u: number, v: number): [number, number] => [
      cx + u * rightX + v * upX,
      cy + u * rightY + v * upY,
    ]
    // 方位マーク寸法 (mm)
    const H = 10 // 半高さ (総高さ = 20)
    const barbW = 3 // 斜め棒の水平ずれ
    const barbV = 4 // 斜め棒の下端の高さ
    const crossW = 4 // 横棒の半幅
    const crossV = -6 // 横棒の高さ (下寄り)
    const linePairs: Array<{
      p1: [number, number]
      p2: [number, number]
      color: number
    }> = [
      // 1) 縦棒: 下端 → 上端 (先端)
      { p1: [0, -H], p2: [0, H], color: COLOR_CODE.black },
      // 2) 斜め棒: 左下 → 先端
      { p1: [-barbW, barbV], p2: [0, H], color: COLOR_CODE.black },
      // 3) 横棒: 左 → 右 (下寄り)
      { p1: [-crossW, crossV], p2: [crossW, crossV], color: COLOR_CODE.black },
      // 4) 先端の閉じる線 (赤): 斜め棒の下端 → 縦棒 (先端三角を閉じる)
      { p1: [-barbW, barbV], p2: [0, barbV], color: COLOR_CODE.red },
    ]
    for (const { p1, p2, color } of linePairs) {
      const [x1, y1] = toPaper(p1[0], p1[1])
      const [x2, y2] = toPaper(p2[0], p2[1])
      emit(
        `#${nextId()} = line_feature('${northLayer}','${color}','${FONT_CONTINUOUS}','${WIDTH_035}','${x1.toFixed(6)}','${y1.toFixed(6)}','${x2.toFixed(6)}','${y2.toFixed(6)}')`,
      )
    }
    // N ラベル (先端の外側)
    const labelSize = 4
    const labelDist = H + labelSize * 0.5
    const [nlx, nly] = toPaper(-(labelSize * textWidthUnits('N')) / 2, labelDist)
    emitText(
      northLayer,
      COLOR_CODE.black,
      'N',
      nlx,
      nly,
      labelSize,
      0,
      1,
    )
  }

  // ===== 追加要素: 基準杭座標一覧表 (右下・図枠内) =====
  // 表は 座標系フッタ を含み、その下 (更に右下) に 縮尺テキスト を置く。
  {
    const paperMax = Math.max(sheet.width, sheet.height)
    const frameInset = paperMax >= 800 ? 20 : 10
    const rightEdge = sheet.width - frameInset - 5 // 表の右端 (用紙 mm)
    let bottomY = frameInset + 5 // 表 (と縮尺) の 現在の下端 y

    // 縮尺テキスト (図面右下)。右端右揃え、bottomY に配置。
    {
      const scaleLayer = registerTextLayer('縮尺')
      const scaleHeight = 5
      const scaleText = `S = 1 : ${scale}`
      const w = scaleHeight * textWidthUnits(scaleText)
      emitText(
        scaleLayer,
        COLOR_CODE.black,
        scaleText,
        rightEdge - w,
        bottomY,
        scaleHeight,
        0,
        1,
      )
      bottomY += scaleHeight * 1.6 // 縮尺の上に表を積む
    }

    if (showReferenceTable) {
      const tableLayer = registerTextLayer('基準杭座標一覧表')
      // 列幅 (mm)
      const colWidths = [15, 24, 24, 16, 15] // 点名 / X / Y / H / 備考
      const tableWidth = colWidths.reduce((a, b) => a + b, 0)
      const rowHeight = 6
      const cellTextHeight = 3
      const headerTextHeight = 3
      const titleTextHeight = 5
      const titlePad = 3 // タイトル下の余白
      const footerTextHeight = 3
      const footerPad = 2

      const nRows = 1 + refPoints.length // ヘッダ 1 行 + データ

      // 座標系ラベル (フッタ)
      const csLabel = coordinateSystem === '2011'
        ? '（座標世界測地系（JGD2011）,公共標高）'
        : coordinateSystem === 'custom'
          ? '（任意座標系,任意標高）'
          : '（座標世界測地系,公共標高）'
      const footerW = footerTextHeight * textWidthUnits(csLabel)

      // 表右下座標
      const tableRight = rightEdge
      const tableLeft = tableRight - tableWidth
      const tableBottom = bottomY + footerTextHeight + footerPad
      const tableTop = tableBottom + rowHeight * nRows
      const titleY = tableTop + titlePad

      // フッタ (表の下、右寄せ)
      emitText(
        tableLayer,
        COLOR_CODE.black,
        csLabel,
        tableRight - footerW,
        bottomY,
        footerTextHeight,
        0,
        1,
      )

      // タイトル (表の上、中央)
      const titleText = '基準杭座標一覧表'
      const titleW = titleTextHeight * textWidthUnits(titleText)
      const titleX = (tableLeft + tableRight) / 2 - titleW / 2
      emitText(
        tableLayer,
        COLOR_CODE.black,
        titleText,
        titleX,
        titleY,
        titleTextHeight,
        0,
        1,
      )
      // タイトル下の下線 (全表幅)
      emit(
        `#${nextId()} = line_feature('${tableLayer}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_035}','${tableLeft.toFixed(6)}','${(titleY - 0.5).toFixed(6)}','${tableRight.toFixed(6)}','${(titleY - 0.5).toFixed(6)}')`,
      )

      // 表の水平線 (nRows+1 本)
      for (let i = 0; i <= nRows; i++) {
        const y = tableBottom + rowHeight * i
        emit(
          `#${nextId()} = line_feature('${tableLayer}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_025}','${tableLeft.toFixed(6)}','${y.toFixed(6)}','${tableRight.toFixed(6)}','${y.toFixed(6)}')`,
        )
      }
      // 表の垂直線 (colWidths.length+1 本)
      let vx = tableLeft
      for (let i = 0; i <= colWidths.length; i++) {
        emit(
          `#${nextId()} = line_feature('${tableLayer}','${COLOR_CODE.black}','${FONT_CONTINUOUS}','${WIDTH_025}','${vx.toFixed(6)}','${tableBottom.toFixed(6)}','${vx.toFixed(6)}','${tableTop.toFixed(6)}')`,
        )
        if (i < colWidths.length) vx += colWidths[i]
      }

      // セル中央にテキストを配置するヘルパ
      const cellCenterX = (colIdx: number): number => {
        let x = tableLeft
        for (let i = 0; i < colIdx; i++) x += colWidths[i]
        return x + colWidths[colIdx] / 2
      }
      const cellText = (
        colIdx: number,
        rowIdx: number, // 0 = ヘッダ, 1..N = データ
        text: string,
        h: number,
      ) => {
        if (!text) return
        const cx = cellCenterX(colIdx)
        // rowIdx=0 は表の一番上の行。tableTop から下に。
        const cyTop = tableTop - rowHeight * rowIdx
        const cyMid = cyTop - rowHeight / 2
        const w = h * textWidthUnits(text)
        emitText(
          tableLayer,
          COLOR_CODE.black,
          text,
          cx - w / 2,
          cyMid - h / 2,
          h,
          0,
          1,
        )
      }
      // ヘッダ行
      const headers = ['点  名', '   X', '   Y', '  H', '備  考']
      for (let c = 0; c < headers.length; c++) {
        cellText(c, 0, headers[c], headerTextHeight)
      }
      // データ行
      for (let r = 0; r < refPoints.length; r++) {
        const rp = refPoints[r]
        const rowIdx = r + 1
        cellText(0, rowIdx, rp.label, cellTextHeight)
        cellText(1, rowIdx, rp.x.toFixed(3), cellTextHeight)
        cellText(2, rowIdx, rp.y.toFixed(3), cellTextHeight)
        cellText(3, rowIdx, rp.z != null ? rp.z.toFixed(2) : '', cellTextHeight)
        cellText(4, rowIdx, rp.remarks ?? '', cellTextHeight)
      }
    }
  }

  // ===== 図面シート + レイヤ =====
  // 用紙サイズコード: A0=0, A1=1, A2=2, A3=3 (SFC 標準)。横長は 2 番目のフィールド '1'。
  const paperCode = paperSizeCode(sheet.width, sheet.height)
  emit(
    `#${nextId()} = drawing_sheet_feature(\\'${fileBase}\\','${paperCode}','1','${sheet.width}','${sheet.height}')`,
  )
  for (const ln of layerNames) {
    emit(`#${nextId()} = layer_feature(\\'${ln}\\','1')`)
  }

  out.push('ENDSEC;')
  out.push('END-ISO-10303-21;')
  return out.join('\r\n') + '\r\n'
}

/** 文字列の "文字高何倍分の幅を占めるか" を返す。
 *  半角 (ASCII / 半角カナ) は 0.5、全角は 1 として集計する。
 *  例: "K7A" (半角 3) → 1.5、"29.50" (半角 5) → 2.5、"測点" (全角 2) → 2.0 */
function textWidthUnits(s: string): number {
  let units = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 128) units += 0.5 // ASCII
    else if (code >= 0xff61 && code <= 0xff9f) units += 0.5 // 半角カタカナ
    else units += 1 // 全角
  }
  return units
}

/** SFC 文字列内のバックスラッシュ・引用符を無害化 */
function escapeSfcString(s: string): string {
  // SFC のリテラルは \' で囲まれる。内部の \\' や制御文字は避ける。
  // 実運用上、単純に \\ と \' を全角に落とすか除去する。
  return s.replace(/\\/g, '/').replace(/'/g, '`')
}

// 用紙サイズ mm (横長固定)
const PAPER_SIZE_MM: Record<'A0' | 'A1' | 'A2' | 'A3', { width: number; height: number }> = {
  A0: { width: 1189, height: 841 },
  A1: { width: 841, height: 594 },
  A2: { width: 594, height: 420 },
  A3: { width: 420, height: 297 },
}

/** SFC drawing_sheet_feature 用の 用紙サイズコード。
 *  A0=0, A1=1, A2=2, A3=3。長辺の長さで判別する。 */
function paperSizeCode(width: number, height: number): number {
  const longer = Math.max(width, height)
  if (longer >= 1189) return 0 // A0
  if (longer >= 841) return 1 // A1
  if (longer >= 594) return 2 // A2
  return 3 // A3
}

// 内容が収まる標準 A サイズシートを選ぶ (横長固定)
function pickSheet(neededW: number, neededH: number): { width: number; height: number } {
  const sizes: Array<{ width: number; height: number }> = [
    { width: 420, height: 297 }, // A3 横
    { width: 594, height: 420 }, // A2 横
    { width: 841, height: 594 }, // A1 横
    { width: 1189, height: 841 }, // A0 横
  ]
  for (const s of sizes) {
    if (neededW <= s.width && neededH <= s.height) return s
  }
  // それでも収まらない場合は必要サイズを直接返す (整数化)
  return { width: Math.ceil(neededW), height: Math.ceil(neededH) }
}

/**
 * 管種切替点を検出する。
 * 各パイプの端点 (先頭/末尾頂点) を空間ハッシュで集約し、同じ位置に
 * 異なる pipeType が 2 つ以上集まっていれば「切替点」とする。
 * 空間ハッシュの粒度は 10mm (0.01m)。
 */
function findTransitionPoints(pipes: PipeRow[]): Array<{ x: number; y: number }> {
  const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`
  const typesAt = new Map<string, Set<string>>()
  const posAt = new Map<string, { x: number; y: number }>()
  for (const p of pipes) {
    if (!p.pipeType || p.vertices.length === 0) continue
    for (const idx of [0, p.vertices.length - 1]) {
      const v = p.vertices[idx]
      const k = key(v.x, v.y)
      let set = typesAt.get(k)
      if (!set) {
        set = new Set()
        typesAt.set(k, set)
        posAt.set(k, { x: v.x, y: v.y })
      }
      set.add(p.pipeType)
    }
  }
  const result: Array<{ x: number; y: number }> = []
  for (const [k, types] of typesAt.entries()) {
    if (types.size >= 2) {
      const pos = posAt.get(k)
      if (pos) result.push(pos)
    }
  }
  return result
}
