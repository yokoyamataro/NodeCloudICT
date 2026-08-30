// AutoCAD R12 (AC1009) ベースの DXF 書き出し。
// 互換性重視：HEADER / TABLES(LTYPE,LAYER,STYLE) / BLOCKS / ENTITIES / EOF を完備し、
// 改行は CRLF、ファイル先頭に BOM を付けない（DXF は ASCII 前提）。
// POINT / LINE / CIRCLE / ARC / TEXT に対応。座標系は CAD 慣例 (X=東, Y=北) で受け取り、そのまま出力する。

export type DxfEntity =
  | { type: 'POINT'; x: number; y: number; layer?: string }
  | { type: 'LINE'; x1: number; y1: number; x2: number; y2: number; layer?: string }
  | { type: 'CIRCLE'; cx: number; cy: number; r: number; layer?: string }
  | {
      type: 'ARC'
      cx: number
      cy: number
      r: number
      startAngleDeg: number
      endAngleDeg: number
      layer?: string
    }
  | {
      type: 'TEXT'
      x: number
      y: number
      text: string
      height?: number
      /** 回転角 [度]。反時計回りが正 */
      rotationDeg?: number
      layer?: string
    }

// 数値整形：科学表記を避け、小数 6 桁に丸める（DXF 仕様準拠）
const num = (n: number): string => {
  if (!Number.isFinite(n)) return '0.0'
  // 1e21 等が出ないよう丸める
  const s = n.toFixed(6)
  // 末尾 0 を削るが、小数点直後の "." 残しは避ける
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0')
}

// グループコード + 値の 1 ペアを push（コード行は 0〜3 桁右詰めにする慣例だが、文字列でも可）
const w = (out: string[], code: number | string, value: string | number) => {
  out.push(String(code), String(value))
}

// 一意なレイヤ名を抽出。空白除去、未指定は "0" に。
const collectLayers = (entities: DxfEntity[]): string[] => {
  const set = new Set<string>(['0'])
  for (const e of entities) {
    const layer = (e.layer ?? '').trim()
    if (layer) set.add(layer)
  }
  return Array.from(set)
}

function writeHeader(out: string[], entities: DxfEntity[]) {
  // 境界範囲（$EXTMIN/$EXTMAX）を計算し、ZoomExtents 時の挙動を安定させる
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  const upd = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const e of entities) {
    switch (e.type) {
      case 'POINT':
      case 'TEXT':
        upd(e.x, e.y)
        break
      case 'LINE':
        upd(e.x1, e.y1)
        upd(e.x2, e.y2)
        break
      case 'CIRCLE':
      case 'ARC':
        upd(e.cx - e.r, e.cy - e.r)
        upd(e.cx + e.r, e.cy + e.r)
        break
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }

  w(out, 0, 'SECTION')
  w(out, 2, 'HEADER')
  // R12 互換（AC1009）。多くの CAD が確実に読み込める最古層。
  w(out, 9, '$ACADVER')
  w(out, 1, 'AC1009')
  w(out, 9, '$INSBASE')
  w(out, 10, num(0))
  w(out, 20, num(0))
  w(out, 30, num(0))
  w(out, 9, '$EXTMIN')
  w(out, 10, num(minX))
  w(out, 20, num(minY))
  w(out, 30, num(0))
  w(out, 9, '$EXTMAX')
  w(out, 10, num(maxX))
  w(out, 20, num(maxY))
  w(out, 30, num(0))
  w(out, 9, '$LIMMIN')
  w(out, 10, num(minX))
  w(out, 20, num(minY))
  w(out, 9, '$LIMMAX')
  w(out, 10, num(maxX))
  w(out, 20, num(maxY))
  w(out, 9, '$ANGBASE')
  w(out, 50, num(0))
  w(out, 9, '$ANGDIR')
  w(out, 70, 0) // 0 = 反時計回り（標準）
  w(out, 9, '$LUNITS')
  w(out, 70, 2) // 小数
  w(out, 9, '$LUPREC')
  w(out, 70, 4) // 表示桁
  w(out, 9, '$AUNITS')
  w(out, 70, 0) // 度
  w(out, 9, '$AUPREC')
  w(out, 70, 0)
  w(out, 9, '$MEASUREMENT')
  w(out, 70, 1) // メートル系
  w(out, 0, 'ENDSEC')
}

function writeTables(out: string[], layers: string[]) {
  w(out, 0, 'SECTION')
  w(out, 2, 'TABLES')

  // ---- LTYPE: CONTINUOUS と BYBLOCK / BYLAYER を必ず宣言 ----
  w(out, 0, 'TABLE')
  w(out, 2, 'LTYPE')
  w(out, 70, 3)
  // BYBLOCK
  w(out, 0, 'LTYPE')
  w(out, 2, 'BYBLOCK')
  w(out, 70, 0)
  w(out, 3, '')
  w(out, 72, 65)
  w(out, 73, 0)
  w(out, 40, num(0))
  // BYLAYER
  w(out, 0, 'LTYPE')
  w(out, 2, 'BYLAYER')
  w(out, 70, 0)
  w(out, 3, '')
  w(out, 72, 65)
  w(out, 73, 0)
  w(out, 40, num(0))
  // CONTINUOUS
  w(out, 0, 'LTYPE')
  w(out, 2, 'CONTINUOUS')
  w(out, 70, 0)
  w(out, 3, 'Solid line')
  w(out, 72, 65)
  w(out, 73, 0)
  w(out, 40, num(0))
  w(out, 0, 'ENDTAB')

  // ---- LAYER: 全レイヤを宣言 ----
  w(out, 0, 'TABLE')
  w(out, 2, 'LAYER')
  w(out, 70, layers.length)
  for (const name of layers) {
    w(out, 0, 'LAYER')
    w(out, 2, name)
    w(out, 70, 0) // フラグ
    w(out, 62, 7) // 色（7=白/黒、画面背景に応じて）
    w(out, 6, 'CONTINUOUS')
  }
  w(out, 0, 'ENDTAB')

  // ---- STYLE: TEXT 用の標準スタイル ----
  w(out, 0, 'TABLE')
  w(out, 2, 'STYLE')
  w(out, 70, 1)
  w(out, 0, 'STYLE')
  w(out, 2, 'STANDARD')
  w(out, 70, 0)
  w(out, 40, num(0)) // 固定高（0=可変）
  w(out, 41, num(1)) // 幅係数
  w(out, 50, num(0)) // 傾斜角
  w(out, 71, 0) // 生成フラグ
  w(out, 42, num(2.5))
  w(out, 3, 'txt') // 主フォントファイル名（標準シェイプフォント）
  w(out, 4, '') // 大文字フォント
  w(out, 0, 'ENDTAB')

  w(out, 0, 'ENDSEC')
}

function writeBlocks(out: string[]) {
  // R12 では BLOCKS セクションが必須（中身が空でも *Model_Space / *Paper_Space は宣言）
  w(out, 0, 'SECTION')
  w(out, 2, 'BLOCKS')
  // *MODEL_SPACE
  w(out, 0, 'BLOCK')
  w(out, 8, '0')
  w(out, 2, '$MODEL_SPACE')
  w(out, 70, 0)
  w(out, 10, num(0))
  w(out, 20, num(0))
  w(out, 30, num(0))
  w(out, 3, '$MODEL_SPACE')
  w(out, 1, '')
  w(out, 0, 'ENDBLK')
  w(out, 8, '0')
  // *PAPER_SPACE
  w(out, 0, 'BLOCK')
  w(out, 8, '0')
  w(out, 67, 1)
  w(out, 2, '$PAPER_SPACE')
  w(out, 70, 0)
  w(out, 10, num(0))
  w(out, 20, num(0))
  w(out, 30, num(0))
  w(out, 3, '$PAPER_SPACE')
  w(out, 1, '')
  w(out, 0, 'ENDBLK')
  w(out, 8, '0')
  w(out, 67, 1)
  w(out, 0, 'ENDSEC')
}

function writeEntities(out: string[], entities: DxfEntity[]) {
  w(out, 0, 'SECTION')
  w(out, 2, 'ENTITIES')

  for (const e of entities) {
    const layer = (e.layer ?? '').trim() || '0'
    switch (e.type) {
      case 'POINT':
        w(out, 0, 'POINT')
        w(out, 8, layer)
        w(out, 10, num(e.x))
        w(out, 20, num(e.y))
        w(out, 30, num(0))
        break
      case 'LINE':
        w(out, 0, 'LINE')
        w(out, 8, layer)
        w(out, 10, num(e.x1))
        w(out, 20, num(e.y1))
        w(out, 30, num(0))
        w(out, 11, num(e.x2))
        w(out, 21, num(e.y2))
        w(out, 31, num(0))
        break
      case 'CIRCLE':
        w(out, 0, 'CIRCLE')
        w(out, 8, layer)
        w(out, 10, num(e.cx))
        w(out, 20, num(e.cy))
        w(out, 30, num(0))
        w(out, 40, num(e.r))
        break
      case 'ARC':
        w(out, 0, 'ARC')
        w(out, 8, layer)
        w(out, 10, num(e.cx))
        w(out, 20, num(e.cy))
        w(out, 30, num(0))
        w(out, 40, num(e.r))
        w(out, 50, num(e.startAngleDeg))
        w(out, 51, num(e.endAngleDeg))
        break
      case 'TEXT':
        w(out, 0, 'TEXT')
        w(out, 8, layer)
        w(out, 10, num(e.x))
        w(out, 20, num(e.y))
        w(out, 30, num(0))
        w(out, 40, num(e.height ?? 0.5))
        // DXF の 1 グループは制御文字不可。改行を空白に置換。
        w(out, 1, (e.text ?? '').replace(/[\r\n]+/g, ' '))
        if (e.rotationDeg) w(out, 50, num(e.rotationDeg))
        w(out, 7, 'STANDARD') // テキストスタイル参照（STYLE で宣言済み）
        break
    }
  }

  w(out, 0, 'ENDSEC')
}

export function buildDxf(entities: DxfEntity[]): string {
  const out: string[] = []
  const layers = collectLayers(entities)
  writeHeader(out, entities)
  writeTables(out, layers)
  writeBlocks(out)
  writeEntities(out, entities)
  w(out, 0, 'EOF')
  // DXF 仕様：改行は CR+LF
  return out.join('\r\n') + '\r\n'
}

export function downloadDxf(text: string, filename: string): void {
  // DXF は ASCII（拡張アスキー）。日本語テキストは多くの環境で UTF-8 で受け入れられるが、
  // 厳格な CAD では Shift_JIS が要る場合あり。ここでは BOM を付けない UTF-8 で出力。
  const blob = new Blob([text], { type: 'application/dxf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.dxf') ? filename : `${filename}.dxf`
  a.click()
  URL.revokeObjectURL(url)
}
