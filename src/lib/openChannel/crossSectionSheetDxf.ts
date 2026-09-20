// 横断図 の DXF を 組む。
//
// 1 測点 = 1 枠。 複数 の 測点 を 選んだ ときは 枠 を 横 に 並べて 1 ファイル に する。
// 紙 の 座標 は mm (左下 原点)。 実寸 → 紙 は 縮尺 の 分母 で 割る:
//   紙 mm = 実 m × 1000 / 縮尺分母   (1/100 なら 1m → 10mm)
//
// 図 の 基準 は 「中心線 と DL の 交点」。 そこ を 紙 の どこ に 置く か を
// center で 指定 する。 DL (データムライン) は 断面 の 下 に 引く 水平線 で、
// 高さ の 読み 始め に なる。

import type { DxfEntity } from '@/lib/dxf'

/** 断面 1 本 の 点。 offset = 中心 から の 離れ (右 +)、z = 標高 */
export interface SheetPoint {
  offset: number
  z: number
}

/** 1 測点 分 の 中身 */
export interface SheetSection {
  /** 見出し (測点名) */
  title: string
  planned: SheetPoint[]
  current: SheetPoint[]
  asbuilt: SheetPoint[]
}

export interface SheetOptions {
  /** 用紙 (mm) */
  paperW: number
  paperH: number
  /** 横 の 縮尺 の 分母 (1/100 → 100) */
  hScale: number
  /** 縦 の 縮尺 の 分母 */
  vScale: number
  /** DL [m] */
  dl: number
  /** 中心線 と DL の 交点 を 紙 の どこ に 置く か (mm、左下 原点) */
  centerX: number
  centerY: number
  /** 出す もの */
  showPlanned: boolean
  showCurrent: boolean
  showAsbuilt: boolean
}

/** 用紙 の 呼び名 と mm (横置き) */
export const PAPER_SIZES: Record<string, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
  A0: { w: 1189, h: 841 },
}

/** 縮尺 の 候補 (分母) */
export const SCALE_STEPS = [50, 100, 200, 250, 500, 1000] as const

const LAYER = {
  frame: 'D-FRAME',
  dl: 'D-DL',
  center: 'D-CL',
  planned: 'D-PLAN',
  current: 'D-CURRENT',
  asbuilt: 'D-ASBUILT',
  text: 'D-TEXT',
}

/** 枠 の 間隔 (mm)。 複数 測点 を 横 に 並べる とき の 余白 */
const SHEET_GAP = 10

/**
 * 自動 の 既定値 を 出す。
 *
 * ・DL … 断面 の 最低 高 より 1m 下 を 0.5m 単位 で 切り下げ
 * ・縮尺 … 断面 の 幅 と 高さ が 枠 に 収まる いちばん 細かい 候補
 * ・中心 … 紙 の 左右 の 真ん中、下 から 30mm (DL の 高さ)
 */
export function suggestSheetOptions(
  sections: SheetSection[],
  paperW: number,
  paperH: number,
): Omit<SheetOptions, 'showPlanned' | 'showCurrent' | 'showAsbuilt'> {
  const pts = sections.flatMap((s) => [...s.planned, ...s.current, ...s.asbuilt])
  const marginX = 20
  const marginBottom = 30
  const marginTop = 25
  if (pts.length === 0) {
    return { paperW, paperH, hScale: 100, vScale: 100, dl: 0, centerX: paperW / 2, centerY: marginBottom }
  }
  const maxAbsOffset = Math.max(...pts.map((p) => Math.abs(p.offset)), 1)
  const minZ = Math.min(...pts.map((p) => p.z))
  const maxZ = Math.max(...pts.map((p) => p.z))
  // DL は 0.5m 単位。 最低 高 の 1m 下 から
  const dl = Math.floor((minZ - 1) * 2) / 2
  const heightM = Math.max(maxZ - dl, 0.5)

  const usableW = paperW - marginX * 2
  const usableH = paperH - marginBottom - marginTop
  // 幅: 片側 maxAbsOffset が 使える 幅 の 半分 に 収まる 分母
  const pick = (needM: number, roomMm: number) => {
    for (const s of SCALE_STEPS) {
      if ((needM * 1000) / s <= roomMm) return s
    }
    return SCALE_STEPS[SCALE_STEPS.length - 1]
  }
  const hScale = pick(maxAbsOffset * 2, usableW)
  const vScale = pick(heightM, usableH)
  return {
    paperW,
    paperH,
    hScale,
    vScale,
    dl,
    centerX: paperW / 2,
    centerY: marginBottom,
  }
}

/** 折れ線 を 線分 の 並び に */
function polyline(
  pts: { x: number; y: number }[],
  layer: string,
  out: DxfEntity[],
): void {
  for (let i = 1; i < pts.length; i += 1) {
    out.push({
      type: 'LINE',
      x1: pts[i - 1].x,
      y1: pts[i - 1].y,
      x2: pts[i].x,
      y2: pts[i].y,
      layer,
    })
  }
}

/** 横断図 を 組む。 1 測点 = 1 枠、横 に 並べる */
export function buildCrossSectionSheets(
  sections: SheetSection[],
  opt: SheetOptions,
): DxfEntity[] {
  const out: DxfEntity[] = []
  sections.forEach((sec, i) => {
    const ox = i * (opt.paperW + SHEET_GAP)
    /** 実寸 → 紙 (mm)。 枠 の 原点 ぶん を 足す */
    const X = (offset: number) => ox + opt.centerX + (offset * 1000) / opt.hScale
    const Y = (z: number) => opt.centerY + ((z - opt.dl) * 1000) / opt.vScale

    // 用紙 の 枠
    out.push(
      { type: 'LINE', x1: ox, y1: 0, x2: ox + opt.paperW, y2: 0, layer: LAYER.frame },
      { type: 'LINE', x1: ox + opt.paperW, y1: 0, x2: ox + opt.paperW, y2: opt.paperH, layer: LAYER.frame },
      { type: 'LINE', x1: ox + opt.paperW, y1: opt.paperH, x2: ox, y2: opt.paperH, layer: LAYER.frame },
      { type: 'LINE', x1: ox, y1: opt.paperH, x2: ox, y2: 0, layer: LAYER.frame },
    )

    // DL (水平線) と 中心線 (縦線)
    const pts = [
      ...(opt.showPlanned ? sec.planned : []),
      ...(opt.showCurrent ? sec.current : []),
      ...(opt.showAsbuilt ? sec.asbuilt : []),
    ]
    const halfM = pts.length > 0 ? Math.max(...pts.map((p) => Math.abs(p.offset)), 1) : 5
    const maxZ = pts.length > 0 ? Math.max(...pts.map((p) => p.z)) : opt.dl + 1
    out.push({
      type: 'LINE',
      x1: X(-halfM * 1.1),
      y1: Y(opt.dl),
      x2: X(halfM * 1.1),
      y2: Y(opt.dl),
      layer: LAYER.dl,
    })
    out.push({
      type: 'LINE',
      x1: X(0),
      y1: Y(opt.dl),
      x2: X(0),
      y2: Y(maxZ) + 5,
      layer: LAYER.center,
    })

    // 断面 の 線
    const toPaper = (ps: SheetPoint[]) =>
      [...ps].sort((a, b) => a.offset - b.offset).map((p) => ({ x: X(p.offset), y: Y(p.z) }))
    if (opt.showPlanned && sec.planned.length >= 2) {
      polyline(toPaper(sec.planned), LAYER.planned, out)
    }
    if (opt.showCurrent && sec.current.length >= 2) {
      polyline(toPaper(sec.current), LAYER.current, out)
    }
    if (opt.showAsbuilt && sec.asbuilt.length >= 2) {
      polyline(toPaper(sec.asbuilt), LAYER.asbuilt, out)
    }

    // 見出し と 諸元
    out.push({
      type: 'TEXT',
      x: ox + 10,
      y: opt.paperH - 14,
      text: sec.title,
      height: 5,
      layer: LAYER.text,
    })
    out.push({
      type: 'TEXT',
      x: ox + 10,
      y: opt.paperH - 22,
      text: `H=1:${opt.hScale}  V=1:${opt.vScale}`,
      height: 3,
      layer: LAYER.text,
    })
    out.push({
      type: 'TEXT',
      x: X(-halfM * 1.1),
      y: Y(opt.dl) - 6,
      text: `DL=${opt.dl.toFixed(3)}`,
      height: 3,
      layer: LAYER.text,
    })
  })
  return out
}
