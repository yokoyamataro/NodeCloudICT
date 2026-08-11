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
}

// SXF 標準の色コード (使う分だけ列挙)
const COLOR_CODE = {
  black: 1,
  red: 2,
  green: 3,
  blue: 4,
  yellow: 5,
  magenta: 6,
  cyan: 7,
} as const
type ColorName = keyof typeof COLOR_CODE
// pre_defined_colour_feature で宣言する順序 (宣言自体に順番の意味はないが並べる)
const DECLARED_COLORS: ColorName[] = ['black', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan']

// SXF 標準の線種コード
const FONT_CONTINUOUS = 1 // continuous

// SXF 標準の線幅コード
const WIDTH_025 = 3 // 0.25mm
const WIDTH_035 = 4 // 0.35mm

// 管種 → 色
const PIPE_TYPE_COLOR: Record<string, ColorName> = {
  main: 'red',           // 集水
  branch: 'black',       // 吸水
  outlet: 'green',       // 落口
  connection: 'magenta', // 連絡渠
  spring: 'blue',        // 湧水処理
  auxiliary: 'cyan',     // 補助暗渠
  self_funded: 'yellow', // 自費施工
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
 */
export function generateSfcPipesContent(
  pipes: PipeRow[],
  options: SfcExportOptions = {},
): string {
  const scale = options.scale ?? 1000
  const paperScale = 1 / scale // 0.001 for 1/1000
  const internalMul = scale // real_meters * internalMul = internal 座標 (mm)
  const symbolRadiusInternal = 1 / paperScale // 1mm 紙上 = internal 1/paperScale
  const fileBase = options.fileBaseName ?? 'plan'
  const filename = `${fileBase}.sfc`
  const now = new Date()
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

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
  emit(`#${nextId()} = width_feature('0.250000')`)
  emit(`#${nextId()} = width_feature('0.350000')`)

  // ===== 配線を管種ごとにグループ化 =====
  const byType = new Map<PipeType | 'unknown', PipeRow[]>()
  for (const p of pipes) {
    const key = (p.pipeType ?? 'unknown') as PipeType | 'unknown'
    const arr = byType.get(key) ?? []
    arr.push(p)
    byType.set(key, arr)
  }

  // sfig_org (管種ごと) → 中に polyline/line 群 → 末尾で sfig_locate
  const sfigNames: string[] = []
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
    const sfigName = `-Pipe-${pt}-`
    sfigNames.push(sfigName)
    const colorName = PIPE_TYPE_COLOR[pt as string] ?? 'black'
    const colorCode = COLOR_CODE[colorName]
    const widthCode = pt === 'main' ? WIDTH_035 : WIDTH_025

    emit(`#${nextId()} = sfig_org_feature(\\'${sfigName}\\','1')`)

    for (const pipe of group) {
      const vs = pipe.vertices
      if (vs.length < 2) continue
      // 引数順: (layer, color, font, width, …)
      if (vs.length === 2) {
        const x1 = (vs[0].x * internalMul).toFixed(6)
        const y1 = (vs[0].y * internalMul).toFixed(6)
        const x2 = (vs[1].x * internalMul).toFixed(6)
        const y2 = (vs[1].y * internalMul).toFixed(6)
        emit(
          `#${nextId()} = line_feature('${layerIdx}','${colorCode}','${FONT_CONTINUOUS}','${widthCode}','${x1}','${y1}','${x2}','${y2}')`,
        )
      } else {
        const xs = vs.map((v) => (v.x * internalMul).toFixed(6)).join(',')
        const ys = vs.map((v) => (v.y * internalMul).toFixed(6)).join(',')
        emit(
          `#${nextId()} = polyline_feature('${layerIdx}','${colorCode}','${FONT_CONTINUOUS}','${widthCode}','${vs.length}','(${xs})','(${ys})')`,
        )
      }
    }
  }

  // ===== 管種切替点の 1mm 円 =====
  const transitions = findTransitionPoints(pipes)
  if (transitions.length > 0) {
    layerIdx += 1
    layerNames.push('記号')
    const symFigName = '-Sym-Transition-'
    sfigNames.push(symFigName)
    emit(`#${nextId()} = sfig_org_feature(\\'${symFigName}\\','1')`)
    for (const t of transitions) {
      const cx = (t.x * internalMul).toFixed(6)
      const cy = (t.y * internalMul).toFixed(6)
      const r = symbolRadiusInternal.toFixed(6)
      emit(
        `#${nextId()} = circle_feature('${layerIdx}','${COLOR_CODE.magenta}','${FONT_CONTINUOUS}','${WIDTH_025}','${cx}','${cy}','${r}')`,
      )
    }
  }

  // ===== sfig_locate (各 sfig_org を 1/scale で配置) =====
  const paperScaleStr = paperScale.toFixed(14)
  for (const name of sfigNames) {
    emit(
      `#${nextId()} = sfig_locate_feature('0',\\'${name}\\','0.000000','0.000000','0.00000000000000','${paperScaleStr}','${paperScaleStr}')`,
    )
  }

  // ===== 図面シート + レイヤ =====
  emit(
    `#${nextId()} = drawing_sheet_feature(\\'${fileBase}\\','1','1','841','594')`,
  )
  for (const ln of layerNames) {
    emit(`#${nextId()} = layer_feature(\\'${ln}\\','1')`)
  }

  out.push('ENDSEC;')
  out.push('END-ISO-10303-21;')
  return out.join('\r\n') + '\r\n'
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
