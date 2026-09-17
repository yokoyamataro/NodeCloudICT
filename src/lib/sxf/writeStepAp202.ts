// SXF (AP202_mode) の P21 を 書く。
//
// これ まで は feature 形式 (`LINE_FEATURE(...)`) で 出して いた が、
// 市販 の CAD は .p21 を AP202 の 図形要素 で 読む もの が 多く、
// 中身 が 空 に 見えて いた。 実物 (doc/*.p21) と 同じ 組み方 に 直す。
//
// 1 つ の 図形 は 「幾何 → 見た目 → styled_item」 の 3 段 で 書く:
//
//   #n  =CARTESIAN_POINT(' ',(x,y));
//   #n+1=POLYLINE(' ',(#n,…));
//   #n+2=CURVE_STYLE(' ',<線種>,<線幅>,<色>);
//   #n+3=PRESENTATION_STYLE_ASSIGNMENT((#n+2));
//   #n+4=( ANNOTATION_CURVE_OCCURRENCE() … STYLED_ITEM((#n+3),#n+1) );
//
// 座標 は 用紙 の 左下 が 原点 で y が 上向き な ので、画面 の y を 反転 する。
// 日本語 は そのまま 置けない ので \X2\…\X0\ (UTF-16 の 16 進) に する。

import type { DrawItem, LineStyle } from '@/features/boundary-survey/floorPlanDraw'

/** 用紙 の 大きさ (mm) */
export interface SheetSize {
  w: number
  h: number
}

/** ISO 10303-21 の 文字列。 非 ASCII は \X2\…\X0\ に 直す */
export function sxfString(s: string): string {
  let out = ''
  let buf = ''
  const flush = () => {
    if (buf) {
      out += `\\X2\\${buf}\\X0\\`
      buf = ''
    }
  }
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) {
      flush()
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch
    } else {
      for (let i = 0; i < ch.length; i += 1) {
        buf += ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      }
    }
  }
  flush()
  return out
}

/** SXF の 既定 の 線種 の 名前 */
function curveFont(style: LineStyle | undefined): string {
  if (style === 'dash') return 'dashed'
  if (style === 'dashdot') return 'chain'
  return 'continuous'
}

const f6 = (v: number) => v.toFixed(6)

/**
 * 描く もの の 並び を AP202 の P21 に する。
 *
 * layerOf は 要素 の レイヤ名 を 返す (既定 は item.layer)。
 * 同じ レイヤ の 図形 は PRESENTATION_LAYER_ASSIGNMENT で まとめる。
 */
export function writeStepAp202(
  items: DrawItem[],
  sheet: SheetSize,
  opts: { title: string; author?: string; org?: string; fontName?: string } = {
    title: '図面',
  },
): string {
  const lines: string[] = []
  let seq = 0
  /** 実体 を 1 つ 足して その 番号 を 返す */
  const put = (body: string): number => {
    seq += 10
    lines.push(`#${seq}=${body};`)
    return seq
  }
  /** 複合 実体 */
  const putC = (parts: string[]): number => {
    seq += 10
    lines.push(`#${seq}=(\n${parts.join('\n')}\n);`)
    return seq
  }

  // ---- 単位 / 色 / 線種 / 線幅 / フォント ----
  const unit = putC(['LENGTH_UNIT()', 'NAMED_UNIT(*)', 'SI_UNIT(.MILLI.,.METRE.)'])
  const colour = put("DRAUGHTING_PRE_DEFINED_COLOUR('black')")
  const fonts = new Map<string, number>()
  for (const name of ['continuous', 'dashed', 'chain']) {
    fonts.set(name, put(`DRAUGHTING_PRE_DEFINED_CURVE_FONT('${name}')`))
  }
  const widths = new Map<string, number>()
  const widthOf = (w: number): number => {
    const key = w.toFixed(2)
    const hit = widths.get(key)
    if (hit != null) return hit
    const id = put(`LENGTH_MEASURE_WITH_UNIT(POSITIVE_LENGTH_MEASURE(${f6(w)}),#${unit})`)
    widths.set(key, id)
    return id
  }
  widthOf(0.13)
  const src = put("EXTERNAL_SOURCE(IDENTIFIER('scadec'))")
  const font = put(
    `EXTERNALLY_DEFINED_TEXT_FONT(IDENTIFIER('${sxfString(opts.fontName ?? 'ＭＳ ゴシック')}'),#${src})`,
  )

  /** 用紙 の 左下 を 原点 に する */
  const Y = (y: number) => sheet.h - y

  const styleOf = (w: number, style: LineStyle | undefined): number => {
    const cs = put(
      `CURVE_STYLE(' ',#${fonts.get(curveFont(style))},#${widthOf(w)},#${colour})`,
    )
    return put(`PRESENTATION_STYLE_ASSIGNMENT((#${cs}))`)
  }

  const curveItem = (geom: number, psa: number): number =>
    putC([
      'ANNOTATION_CURVE_OCCURRENCE()',
      'ANNOTATION_OCCURRENCE()',
      'DRAUGHTING_ANNOTATION_OCCURRENCE()',
      'GEOMETRIC_REPRESENTATION_ITEM()',
      "REPRESENTATION_ITEM(' ')",
      `STYLED_ITEM((#${psa}),#${geom})`,
    ])

  // ---- 図形 ----
  const byLayer = new Map<string, number[]>()
  const addTo = (layer: string, id: number) => {
    const arr = byLayer.get(layer)
    if (arr) arr.push(id)
    else byLayer.set(layer, [id])
  }

  for (const it of items) {
    if (it.kind === 'line' || it.kind === 'poly') {
      const pts =
        it.kind === 'line'
          ? [
              { x: it.x1, y: it.y1 },
              { x: it.x2, y: it.y2 },
            ]
          : it.closed
          ? [...it.pts, it.pts[0]]
          : it.pts
      if (pts.length < 2) continue
      const ids = pts.map((p) => put(`CARTESIAN_POINT(' ',(${f6(p.x)},${f6(Y(p.y))}))`))
      const poly = put(`POLYLINE(' ',(${ids.map((i) => `#${i}`).join(',')}))`)
      addTo(it.layer, curveItem(poly, styleOf(it.w, it.style)))
    } else if (it.kind === 'circle') {
      const c = put(`CARTESIAN_POINT(' ',(${f6(it.cx)},${f6(Y(it.cy))}))`)
      const ax = put(`AXIS2_PLACEMENT_2D(' ',#${c},$)`)
      const ci = put(`CIRCLE(' ',#${ax},${f6(it.r)})`)
      addTo(it.layer, curveItem(ci, styleOf(it.w, undefined)))
    } else {
      // 字間 を 空ける 指定 は 1 文字 ずつ に 割る
      const chars = it.pitch && it.pitch > 0 ? Array.from(it.text) : [it.text]
      const step = it.pitch ?? 0
      const rad = (-it.rot * Math.PI) / 180
      chars.forEach((ch, i) => {
        if (!ch.trim()) return
        const x = it.x + Math.cos(rad) * step * i
        const y = it.y + Math.sin(rad) * step * i
        const align =
          chars.length > 1
            ? 'baseline left'
            : it.anchor === 'middle'
            ? 'baseline center'
            : it.anchor === 'end'
            ? 'baseline right'
            : 'baseline left'
        const cw = it.h * 0.8
        const ext = put(`PLANAR_EXTENT(' ',${f6(cw * Array.from(ch).length)},${f6(it.h)})`)
        const dir = put(
          `DIRECTION(' ',(${f6(Math.cos((it.rot * Math.PI) / 180))},${f6(
            Math.sin((it.rot * Math.PI) / 180),
          )}))`,
        )
        const org = put(`CARTESIAN_POINT(' ',(${f6(x)},${f6(Y(y))}))`)
        const pl = put(`AXIS2_PLACEMENT_2D(' ',#${org},#${dir})`)
        const lit = put(
          `TEXT_LITERAL_WITH_EXTENT('$$SXF_${align}','${sxfString(ch)}',#${pl},` +
            `'${align}',.RIGHT.,#${font},#${ext})`,
        )
        const tsf = put(`TEXT_STYLE_FOR_DEFINED_FONT(#${colour})`)
        const ts = putC([
          `TEXT_STYLE(' ',#${tsf})`,
          `TEXT_STYLE_WITH_BOX_CHARACTERISTICS((BOX_HEIGHT(${f6(it.h)}),BOX_WIDTH(${f6(
            cw,
          )}),BOX_SLANT_ANGLE(0.000000),BOX_ROTATE_ANGLE(0.000000)))`,
          'TEXT_STYLE_WITH_SPACING(LENGTH_MEASURE(0.000000))',
        ])
        const psa = put(`PRESENTATION_STYLE_ASSIGNMENT((#${ts}))`)
        addTo(
          it.layer,
          putC([
            'ANNOTATION_OCCURRENCE()',
            'ANNOTATION_TEXT_OCCURRENCE()',
            'DRAUGHTING_ANNOTATION_OCCURRENCE()',
            'GEOMETRIC_REPRESENTATION_ITEM()',
            "REPRESENTATION_ITEM(' ')",
            `STYLED_ITEM((#${psa}),#${lit})`,
          ]),
        )
      })
    }
  }

  // ---- レイヤ ----
  const all: number[] = []
  for (const [layer, ids] of byLayer) {
    all.push(...ids)
    put(
      `PRESENTATION_LAYER_ASSIGNMENT('${sxfString(layer)}',' ',(${ids
        .map((i) => `#${i}`)
        .join(',')}))`,
    )
  }

  // ---- 用紙 ----
  const angleUnit = putC(['NAMED_UNIT(*)', 'PLANE_ANGLE_UNIT()', 'SI_UNIT($,.RADIAN.)'])
  const lenUnit = putC(['LENGTH_UNIT()', 'NAMED_UNIT(*)', 'SI_UNIT(.MILLI.,.METRE.)'])
  const ctx = putC([
    'GEOMETRIC_REPRESENTATION_CONTEXT(2)',
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${angleUnit},#${lenUnit}))`,
    "REPRESENTATION_CONTEXT('ID1','2D')",
  ])
  const o = put("CARTESIAN_POINT(' ',(0.000000,0.000000))")
  const d = put("DIRECTION(' ',(1.000000,0.000000))")
  const ax = put(`AXIS2_PLACEMENT_2D(' ',#${o},#${d})`)
  const box = put(`PLANAR_BOX(' ',${f6(sheet.w)},${f6(sheet.h)},#${ax})`)
  const rev = put(
    `DRAWING_SHEET_REVISION('FREE',(${all.map((i) => `#${i}`).join(',')}),#${ctx},'01')`,
  )
  put(`PRESENTATION_SIZE(#${rev},#${box})`)

  // ---- ヘッダ ----
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace('T', 'T')
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('SCADEC level2 AP202_mode'),'2;1');",
    `FILE_NAME('${sxfString(opts.title)}.p21','${stamp}',('${sxfString(
      opts.author ?? '',
    )}'),('${sxfString(opts.org ?? '')}'),'SCADEC_API_Ver3.10','NodeCloudICT','');`,
    "FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));",
    'ENDSEC;',
    'DATA;',
  ]
  return [...head, ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\r\n') + '\r\n'
}
