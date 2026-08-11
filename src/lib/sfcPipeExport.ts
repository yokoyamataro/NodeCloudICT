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
//
// SXF の feature 引数順は (layer, color, font, width, …)。
// color/font/width は SXF 標準の絶対インデックスを参照する
// (pre_defined_*_feature 宣言はそれらを "使う" ことの明示のみ):
//   色:   1=black 2=red 3=green 4=blue 5=yellow 6=magenta 7=cyan …
//   線種: 1=continuous 2=dashed 3=dashed_spaced …
//   線幅: 1=0.13 2=0.18 3=0.25 4=0.35 5=0.50 6=0.70 …
//
// 現時点のスコープ: 配線の形状 (polyline) と 管種切替点 (円) のみ。
// 文字ラベル・ハッチング・図枠等はスコープ外。

import type { PipeRow } from '@/stores/underdrainStore'
import { PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import type { PipeType } from '@/types/database'

export interface SfcExportOptions {
  /** ファイル名 (拡張子除く) */
  fileBaseName?: string
  /** 図面縮尺 (例: 1000 → 1/1000) */
  scale?: number
  /**
   * true のとき、feature 内の座標を 現地座標 (mm 単位 = 実 m × 1000) に
   * 保存し、sfig_org + sfig_locate_feature で 縮尺・原点・回転を適用する。
   * TREND-ONE の "現地座標" 系ファイルと同じ扱いになる。
   */
  preserveSurveyCoords?: boolean
  /** 用紙上の回転角 (度、CCW を正)。preserveSurveyCoords 時のみ意味を持つ */
  rotationDeg?: number
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
const DECLARED_COLORS: ColorName[] = ['green', 'yellow', 'magenta', 'lightblue']

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
  //   survey-mode:
  //     content 座標 = real m × 1000 (mm at real scale)
  //     sfig_locate scale=1/scale=0.001、angle=rotationDeg で用紙位置決め
  //     offset は 回転後の bbox min が 用紙原点+margin に来るよう計算
  //   paper-mode:
  //     content 座標 = そのまま paper mm (top-level 出力)
  let sheet: { width: number; height: number }
  let toContent: (x: number, y: number) => { cx: number; cy: number }
  let sfigTransform: { offsetX: number; offsetY: number } | null = null

  if (preserveSurvey) {
    // 回転 bbox
    const rad = (rotationDeg * Math.PI) / 180
    const cs = Math.cos(rad)
    const sn = Math.sin(rad)
    const corners: Array<[number, number]> = [
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
    ]
    let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity
    for (const [x, y] of corners) {
      // real m を回転 → 回転後 m (これがそのまま paper mm 相当、1/1000 のとき)
      const rx = cs * x - sn * y
      const ry = sn * x + cs * y
      if (rx < rMinX) rMinX = rx
      if (ry < rMinY) rMinY = ry
      if (rx > rMaxX) rMaxX = rx
      if (ry > rMaxY) rMaxY = ry
    }
    const contentW = (rMaxX - rMinX) * mToPaperMm + marginMm * 2
    const contentH = (rMaxY - rMinY) * mToPaperMm + marginMm * 2
    sheet = pickSheet(contentW, contentH)
    // sfig_locate の offset (mm): 回転後 bbox 最小点が margin に来る
    sfigTransform = {
      offsetX: marginMm - rMinX * mToPaperMm,
      offsetY: marginMm - rMinY * mToPaperMm,
    }
    // content 座標 = real m × 1000 (sfig_locate の scale=0.001 で mm に戻る)
    toContent = (x, y) => ({ cx: x * 1000, cy: y * 1000 })
  } else {
    const contentW = (maxX - minX) * mToPaperMm + marginMm * 2
    const contentH = (maxY - minY) * mToPaperMm + marginMm * 2
    sheet = pickSheet(contentW, contentH)
    toContent = (x, y) => ({
      cx: (x - minX) * mToPaperMm + marginMm,
      cy: (y - minY) * mToPaperMm + marginMm,
    })
  }

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

  // ===== survey-mode: 現地座標保持用の sfig_org を開く =====
  const surveyFigName = '-Pipes-Survey-'
  if (preserveSurvey) {
    emit(`#${nextId()} = sfig_org_feature(\\'${surveyFigName}\\','1')`)
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

  // ===== 管種切替点の 1mm 円 =====
  //   survey-mode: content 座標は real m × 1000 なので、sfig_locate scale=0.001
  //     を通すと content 半径 = scale で用紙 1mm になる (scale=1000 → 1000)
  //   paper-mode: content 座標がそのまま paper mm なので 半径 = 1
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

  // ===== survey-mode: sfig_locate で 縮尺 / 原点 / 回転 を適用 =====
  if (preserveSurvey && sfigTransform) {
    const s = (1 / scale).toFixed(14)
    emit(
      `#${nextId()} = sfig_locate_feature('0',\\'${surveyFigName}\\','${sfigTransform.offsetX.toFixed(6)}','${sfigTransform.offsetY.toFixed(6)}','${rotationDeg.toFixed(14)}','${s}','${s}')`,
    )
  }

  // ===== 図面シート + レイヤ =====
  emit(
    `#${nextId()} = drawing_sheet_feature(\\'${fileBase}\\','1','1','${sheet.width}','${sheet.height}')`,
  )
  for (const ln of layerNames) {
    emit(`#${nextId()} = layer_feature(\\'${ln}\\','1')`)
  }

  out.push('ENDSEC;')
  out.push('END-ISO-10303-21;')
  return out.join('\r\n') + '\r\n'
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
