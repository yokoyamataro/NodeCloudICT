// AI 補助前提の暗渠 CAD (DXF) パーサ。
//
// 目的:
//   ・LINE / CIRCLE / TEXT / MTEXT の 4 種類を entity として取り出す
//   ・レイヤ (グループコード 8) を保持
//   ・座標は DXF そのまま (X=東, Y=北 想定なし、後段で平面直角座標に合わせる)
//
// 既存の src/lib/dxf-parser.ts は「LINE/POLYLINE を平面直角座標に swap」する
// 別関数で、レイヤ検出も TEXT/CIRCLE 未対応のため、AI 解析用は別モジュールに
// 分離。命名衝突を避けるため型も別名 (RawDxfEntity 等) にしている。

import Encoding from 'encoding-japanese'

export type DxfEntityType = 'LINE' | 'CIRCLE' | 'TEXT' | 'MTEXT'

export interface DxfLineEntity {
  type: 'LINE'
  layer: string
  x1: number
  y1: number
  z1: number
  x2: number
  y2: number
  z2: number
}

export interface DxfCircleEntity {
  type: 'CIRCLE'
  layer: string
  cx: number
  cy: number
  cz: number
  radius: number
}

export interface DxfTextEntity {
  type: 'TEXT' | 'MTEXT'
  layer: string
  x: number
  y: number
  z: number
  content: string
  height: number
  /** ラジアン、DXF の 50 (rotation degrees) を rad に変換 */
  rotationRad: number
}

export type RawDxfEntity =
  | DxfLineEntity
  | DxfCircleEntity
  | DxfTextEntity

export interface DxfParseResult {
  entities: RawDxfEntity[]
  /** レイヤ名一覧 (entities に登場したもの) */
  layers: string[]
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

// ================================================================
// Shift-JIS を含む DXF を UTF-8 文字列にデコードする。
// DXF ヘッダに $DWGCODEPAGE = ANSI_932 (Shift-JIS) が入っているものは
// TextDecoder('shift-jis') で読む。それ以外は UTF-8。
// ================================================================
export async function readDxfFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  // まず先頭 4KB を UTF-8 で読み、$DWGCODEPAGE の値を見る
  const head = new TextDecoder('utf-8', { fatal: false }).decode(
    new Uint8Array(buffer.slice(0, 4096)),
  )
  const isShiftJis = /\$DWGCODEPAGE[\s\S]*?ANSI_932/.test(head)
  if (isShiftJis) {
    // encoding-japanese は Uint8Array を受け取れる
    const bytes = new Uint8Array(buffer)
    const unicodeArr = Encoding.convert(bytes, {
      to: 'UNICODE',
      from: 'SJIS',
    }) as number[]
    return Encoding.codeToString(unicodeArr)
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(buffer))
}

// ================================================================
// パーサ本体: ENTITIES セクションだけを 1 パスでスキャン
// ================================================================
export function parseDxf(content: string): DxfParseResult {
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  const entities: RawDxfEntity[] = []
  const layers = new Set<string>()

  let i = findEntitiesStart(lines)
  if (i < 0) {
    // ENTITIES セクションが無い DXF (レア) → 空を返す
    return { entities: [], layers: [], bounds: emptyBounds() }
  }

  while (i < lines.length) {
    const code = lines[i]
    if (code !== '0') {
      i++
      continue
    }
    const typ = lines[i + 1]
    if (typ === 'ENDSEC' || typ === 'EOF') break

    if (typ === 'LINE') {
      const { entity, next } = readEntity(lines, i + 2, 'LINE')
      if (entity) {
        entities.push(entity)
        layers.add(entity.layer)
      }
      i = next
    } else if (typ === 'CIRCLE') {
      const { entity, next } = readEntity(lines, i + 2, 'CIRCLE')
      if (entity) {
        entities.push(entity)
        layers.add(entity.layer)
      }
      i = next
    } else if (typ === 'TEXT') {
      const { entity, next } = readEntity(lines, i + 2, 'TEXT')
      if (entity) {
        entities.push(entity)
        layers.add(entity.layer)
      }
      i = next
    } else if (typ === 'MTEXT') {
      const { entity, next } = readEntity(lines, i + 2, 'MTEXT')
      if (entity) {
        entities.push(entity)
        layers.add(entity.layer)
      }
      i = next
    } else {
      // 他の 0-key entity は skip: 次の 0 を探す
      i += 2
    }
  }

  return {
    entities,
    layers: Array.from(layers).sort(),
    bounds: computeBounds(entities),
  }
}

// ================================================================
// 1 entity を読む (次の 0 コードまで)
// ================================================================
function readEntity(
  lines: string[],
  start: number,
  type: DxfEntityType,
): { entity: RawDxfEntity | null; next: number } {
  let i = start
  const kv = new Map<string, string[]>()  // 同一 code の複数値も保持
  while (i < lines.length) {
    const code = lines[i]
    if (code === '0') break
    const value = lines[i + 1] ?? ''
    const arr = kv.get(code) ?? []
    arr.push(value)
    kv.set(code, arr)
    i += 2
  }
  const layer = kv.get('8')?.[0] ?? '0'

  const num = (code: string, dflt = 0): number => {
    const v = kv.get(code)?.[0]
    if (v == null) return dflt
    const n = Number(v)
    return Number.isFinite(n) ? n : dflt
  }

  if (type === 'LINE') {
    return {
      entity: {
        type: 'LINE',
        layer,
        x1: num('10'),
        y1: num('20'),
        z1: num('30'),
        x2: num('11'),
        y2: num('21'),
        z2: num('31'),
      },
      next: i,
    }
  }
  if (type === 'CIRCLE') {
    return {
      entity: {
        type: 'CIRCLE',
        layer,
        cx: num('10'),
        cy: num('20'),
        cz: num('30'),
        radius: num('40'),
      },
      next: i,
    }
  }
  if (type === 'TEXT') {
    // TEXT は基準点コードが 10/20 (72=0 のとき) or 11/21 (72≠0)。
    // 実務では 10/20 で問題ないことが多い。両方セットされていれば 10/20 優先。
    const rotDeg = num('50')
    return {
      entity: {
        type: 'TEXT',
        layer,
        x: num('10'),
        y: num('20'),
        z: num('30'),
        content: normalizeText(kv.get('1')?.[0] ?? ''),
        height: num('40'),
        rotationRad: (rotDeg * Math.PI) / 180,
      },
      next: i,
    }
  }
  // MTEXT
  const rotDeg = num('50')
  // MTEXT は複数の 1/3 で内容を分割保存することがある。3 が「追加行」、1 が
  // 「本体」。順序は書き込み順のはずなので、素直に 3... + 1 で連結する。
  const extraLines = kv.get('3') ?? []
  const mainLine = kv.get('1')?.[0] ?? ''
  const rawContent = extraLines.concat([mainLine]).join('')
  return {
    entity: {
      type: 'MTEXT',
      layer,
      x: num('10'),
      y: num('20'),
      z: num('30'),
      content: normalizeText(rawContent),
      height: num('40'),
      rotationRad: (rotDeg * Math.PI) / 180,
    },
    next: i,
  }
}

// ================================================================
// TEXT / MTEXT の内容から MTEXT フォーマットコードやエスケープを除去。
// ・\P → 改行 (単なる区切り)
// ・\U+xxxx → Unicode 復元
// ・\S...^... → 分数表記の簡略化 (先頭/末尾のみ残す)
// ・{\...} → コード除去
// ================================================================
function normalizeText(s: string): string {
  if (!s) return ''
  let t = s
  // \U+xxxx を実文字に
  t = t.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
  // \P (改行)
  t = t.replace(/\\P/g, ' ')
  // フォント/色/スタックコード等 {\fArial|...;text} → text
  t = t.replace(/\{\\[^;]+;([^}]*)\}/g, '$1')
  // 残った制御コード \X;
  t = t.replace(/\\[A-Za-z][^;]*;/g, '')
  // 前後空白を trim (但し中間は保持)
  return t.trim()
}

// ================================================================
// ENTITIES セクションの開始位置を探す
// ================================================================
function findEntitiesStart(lines: string[]): number {
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '0' && lines[i + 1] === 'SECTION') {
      // 次の 2/ENTITIES を確認
      let j = i + 2
      while (j < lines.length - 1) {
        if (lines[j] === '0') break
        if (lines[j] === '2' && lines[j + 1] === 'ENTITIES') return j + 2
        j += 2
      }
    }
  }
  return -1
}

// ================================================================
// 境界計算 (プレビューやフィット用)
// ================================================================
function computeBounds(entities: RawDxfEntity[]): DxfParseResult['bounds'] {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  const upd = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const e of entities) {
    if (e.type === 'LINE') {
      upd(e.x1, e.y1)
      upd(e.x2, e.y2)
    } else if (e.type === 'CIRCLE') {
      upd(e.cx - e.radius, e.cy - e.radius)
      upd(e.cx + e.radius, e.cy + e.radius)
    } else {
      upd(e.x, e.y)
    }
  }
  if (!Number.isFinite(minX)) return emptyBounds()
  return { minX, maxX, minY, maxY }
}

function emptyBounds(): DxfParseResult['bounds'] {
  return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
}

// ================================================================
// レイヤの内容統計 (レイヤ振り分け UI の自動推定に使う)
// ================================================================
export interface LayerStats {
  name: string
  lineCount: number
  circleCount: number
  textCount: number
  /** 配管候補スコア (LINE + CIRCLE が多いほど高い) */
  pipeScore: number
  /** 情報候補スコア (TEXT/MTEXT が多いほど高い) */
  infoScore: number
}

export function layerStats(result: DxfParseResult): LayerStats[] {
  const map = new Map<string, LayerStats>()
  for (const layer of result.layers) {
    map.set(layer, {
      name: layer,
      lineCount: 0,
      circleCount: 0,
      textCount: 0,
      pipeScore: 0,
      infoScore: 0,
    })
  }
  for (const e of result.entities) {
    const s = map.get(e.layer)!
    if (e.type === 'LINE') s.lineCount++
    else if (e.type === 'CIRCLE') s.circleCount++
    else s.textCount++
  }
  for (const s of map.values()) {
    const total = s.lineCount + s.circleCount + s.textCount
    if (total === 0) continue
    s.pipeScore = (s.lineCount + s.circleCount) / total
    s.infoScore = s.textCount / total
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}
