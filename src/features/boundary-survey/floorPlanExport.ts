// 建物図面・各階平面図 の 出力。
//
//   p21 … SXF (feature 形式) の 線・文字。 図面 と して 編集 できる
//   tif … 400dpi の 白黒 2 値。 登記 の 提出 は これ が 普通
//   pdf … 上 の 画像 を そのまま 1 枚 に 収めた もの
//
// tif / pdf は 同じ ラスタ から 作る。 日本語 を 字形 に 落とす 手段 が
// 画面 の フォント しか 無い ので、文字 は 画布 に 描いて 画素 に する。
// p21 だけ は 文字 も 文字 の まま 出せる。

import { SHEET, type DrawItem, type DrawText } from './floorPlanDraw'

// ========================================================================
// 画布 に 描く (tif / pdf の 元)
// ========================================================================

/** 用紙 を 画布 に 描く。 dpi は 400 が 既定 (登記 の 提出 に 合わせる) */
export function renderToCanvas(items: DrawItem[], dpi = 400): HTMLCanvasElement {
  const pxPerMm = dpi / 25.4
  const cv = document.createElement('canvas')
  cv.width = Math.round(SHEET.w * pxPerMm)
  cv.height = Math.round(SHEET.h * pxPerMm)
  const g = cv.getContext('2d')
  if (!g) return cv

  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, cv.width, cv.height)
  g.strokeStyle = '#000000'
  g.fillStyle = '#000000'
  g.lineCap = 'butt'
  g.lineJoin = 'miter'

  const X = (mm: number) => mm * pxPerMm
  for (const it of items) {
    if (it.kind === 'line') {
      g.setLineDash(it.dash ? [X(1.2), X(0.8)] : [])
      g.lineWidth = Math.max(1, X(it.w))
      g.beginPath()
      g.moveTo(X(it.x1), X(it.y1))
      g.lineTo(X(it.x2), X(it.y2))
      g.stroke()
    } else if (it.kind === 'poly') {
      if (it.pts.length < 2) continue
      g.setLineDash(it.dash ? [X(1.2), X(0.8)] : [])
      g.lineWidth = Math.max(1, X(it.w))
      g.beginPath()
      g.moveTo(X(it.pts[0].x), X(it.pts[0].y))
      for (let i = 1; i < it.pts.length; i += 1) g.lineTo(X(it.pts[i].x), X(it.pts[i].y))
      if (it.closed) g.closePath()
      g.stroke()
    } else {
      drawTextOnCanvas(g, it, pxPerMm)
    }
  }
  g.setLineDash([])
  return cv
}

const FONT = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "MS Gothic", sans-serif'

function drawTextOnCanvas(g: CanvasRenderingContext2D, it: DrawText, pxPerMm: number) {
  const size = it.h * pxPerMm
  g.save()
  g.font = `${it.bold ? 'bold ' : ''}${size}px ${FONT}`
  g.textBaseline = 'alphabetic'
  g.textAlign = it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left'
  g.translate(it.x * pxPerMm, it.y * pxPerMm)
  if (it.rot) g.rotate((-it.rot * Math.PI) / 180)
  if (it.pitch && it.pitch > 0) {
    // 字間 を 空ける 指定 は 1 文字 ずつ 置く
    const chars = Array.from(it.text)
    const step = it.pitch * pxPerMm
    const total = step * (chars.length - 1)
    const start = it.anchor === 'middle' ? -total / 2 : it.anchor === 'end' ? -total : 0
    g.textAlign = 'left'
    chars.forEach((c, i) => g.fillText(c, start + step * i, 0))
  } else {
    g.fillText(it.text, 0, 0)
  }
  g.restore()
}

// ========================================================================
// TIFF (白黒 2 値・無圧縮)
// ========================================================================

/**
 * 画布 を 白黒 2 値 の TIFF に する。
 * 圧縮 は 掛けない。 400dpi の B4 で 3 MB 弱 に 収まる ので 実用上 困らない。
 */
export function canvasToTiff(cv: HTMLCanvasElement, dpi = 400): Blob {
  const g = cv.getContext('2d')
  if (!g) throw new Error('画像を作れませんでした')
  const { width: w, height: h } = cv
  const src = g.getImageData(0, 0, w, h).data

  // 1 行 は バイト境界 に 揃える。 1 = 黒 (PhotometricInterpretation = 0)
  const rowBytes = Math.ceil(w / 8)
  const bits = new Uint8Array(rowBytes * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      // 白 地 に 黒 線。 半端 な 濃さ は 中間 で 切る
      const lum = (src[i] * 299 + src[i + 1] * 587 + src[i + 2] * 114) / 1000
      if (lum < 160) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  const TAGS = 11
  const ifdOffset = 8
  const ifdSize = 2 + TAGS * 12 + 4
  // 分母 つき の 値 (解像度) を IFD の 後 に 置く
  const resOffset = ifdOffset + ifdSize
  const dataOffset = resOffset + 16
  const buf = new ArrayBuffer(dataOffset + bits.length)
  const dv = new DataView(buf)
  const LE = true

  dv.setUint16(0, 0x4949, LE) // 'II' リトルエンディアン
  dv.setUint16(2, 42, LE)
  dv.setUint32(4, ifdOffset, LE)
  dv.setUint16(ifdOffset, TAGS, LE)

  let p = ifdOffset + 2
  const entry = (tag: number, type: number, count: number, value: number) => {
    dv.setUint16(p, tag, LE)
    dv.setUint16(p + 2, type, LE)
    dv.setUint32(p + 4, count, LE)
    if (type === 3 && count === 1) {
      dv.setUint16(p + 8, value, LE)
      dv.setUint16(p + 10, 0, LE)
    } else {
      dv.setUint32(p + 8, value, LE)
    }
    p += 12
  }
  entry(256, 3, 1, w) // ImageWidth
  entry(257, 3, 1, h) // ImageLength
  entry(258, 3, 1, 1) // BitsPerSample
  entry(259, 3, 1, 1) // Compression = 無圧縮
  entry(262, 3, 1, 0) // Photometric = WhiteIsZero (0=白)
  entry(273, 4, 1, dataOffset) // StripOffsets
  entry(278, 4, 1, h) // RowsPerStrip = 全部 1 枚
  entry(279, 4, 1, bits.length) // StripByteCounts
  entry(282, 5, 1, resOffset) // XResolution
  entry(283, 5, 1, resOffset + 8) // YResolution
  entry(296, 3, 1, 2) // ResolutionUnit = inch
  dv.setUint32(p, 0, LE) // 次 の IFD は 無い

  dv.setUint32(resOffset, dpi, LE)
  dv.setUint32(resOffset + 4, 1, LE)
  dv.setUint32(resOffset + 8, dpi, LE)
  dv.setUint32(resOffset + 12, 1, LE)

  new Uint8Array(buf).set(bits, dataOffset)
  return new Blob([buf], { type: 'image/tiff' })
}

// ========================================================================
// PDF (画像 を 1 枚 に 収める)
// ========================================================================

/**
 * 画布 を B4 横 1 枚 の PDF に する。
 *
 * 日本語 の 字形 を 埋め込む には フォント が 要る ので、文字 も 含めて
 * 画像 に して しまう。 提出 に 使う のは tif な ので、pdf は 確認用。
 */
export async function canvasToPdf(cv: HTMLCanvasElement): Promise<Blob> {
  const dataUrl = cv.toDataURL('image/jpeg', 0.92)
  const jpeg = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))

  // 用紙 は mm → pt (1 pt = 1/72 inch)
  const wPt = (SHEET.w * 72) / 25.4
  const hPt = (SHEET.h * 72) / 25.4

  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let pos = 0
  const put = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b
    chunks.push(u)
    pos += u.length
  }
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = pos
    put(`${n} 0 obj\n${body}\n`)
    if (stream) {
      put('stream\n')
      put(stream)
      put('\nendstream\n')
    }
    put('endobj\n')
  }

  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  )
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`
  obj(4, `<< /Length ${content.length} >>`, enc.encode(content))
  obj(
    5,
    `<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg,
  )

  const xref = pos
  let table = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i += 1) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  put(table)
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

// ========================================================================
// SXF (P21 / feature 形式)
// ========================================================================

/**
 * 描く もの の 並び を SXF の P21 に する。
 *
 * SXF は 用紙 の 左下 が 原点 で y が 上向き な ので 上下 を 返す。
 * 色 (1=黒) と 線種 (1=実線) は 既定 の 番号 を そのまま 使い、
 * 線幅 と レイヤ だけ 出現順 に 定義 する。
 */
export function buildP21(items: DrawItem[], title: string): string {
  const layers: string[] = []
  const widths: number[] = []
  const layerNo = (name: string) => {
    const i = layers.indexOf(name)
    if (i >= 0) return i + 1
    layers.push(name)
    return layers.length
  }
  const widthNo = (w: number) => {
    const v = Math.round(w * 100) / 100
    const i = widths.indexOf(v)
    if (i >= 0) return i + 1
    widths.push(v)
    return widths.length
  }

  const Y = (y: number) => SHEET.h - y
  const n3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3)
  const body: string[] = []

  for (const it of items) {
    const lay = layerNo(it.layer)
    if (it.kind === 'line') {
      body.push(
        `LINE_FEATURE(${lay},1,${it.dash ? 2 : 1},${widthNo(it.w)},` +
          `${n3(it.x1)},${n3(Y(it.y1))},${n3(it.x2)},${n3(Y(it.y2))})`,
      )
    } else if (it.kind === 'poly') {
      const pts = it.closed ? [...it.pts, it.pts[0]] : it.pts
      if (pts.length < 2) continue
      body.push(
        `POLYLINE_FEATURE(${lay},1,${it.dash ? 2 : 1},${widthNo(it.w)},${pts.length},` +
          `(${pts.map((p) => n3(p.x)).join(',')}),(${pts.map((p) => n3(Y(p.y))).join(',')}))`,
      )
    } else {
      // 字間 を 空ける 指定 は 1 文字 ずつ に 割る
      const chars = it.pitch && it.pitch > 0 ? Array.from(it.text) : [it.text]
      const step = it.pitch ?? 0
      chars.forEach((c, i) => {
        if (!c.trim()) return
        const rad = (-it.rot * Math.PI) / 180
        const x = it.x + Math.cos(rad) * step * i
        const y = it.y + Math.sin(rad) * step * i
        const bh = chars.length > 1 ? 1 : it.anchor === 'end' ? 3 : it.anchor === 'middle' ? 2 : 1
        body.push(
          `TEXT_STRING_FEATURE(${lay},1,1,'${esc(c)}',` +
            `${n3(x)},${n3(Y(y))},${n3(it.h)},${n3(it.h)},0.000,` +
            `${n3(it.rot)},0.000,${bh},1,1)`,
        )
      })
    }
  }

  const head: string[] = []
  head.push(`DRAWING_SHEET_FEATURE('${esc(title)}',9,1,${SHEET.w.toFixed(3)},${SHEET.h.toFixed(3)})`)
  for (const l of layers) head.push(`LAYER_FEATURE('${esc(l)}',1)`)
  for (const w of widths) head.push(`WIDTH_FEATURE(${w.toFixed(2)})`)

  const stamp = new Date().toISOString().slice(0, 19)
  const lines: string[] = []
  lines.push('ISO-10303-21;')
  lines.push('HEADER;')
  lines.push("FILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');")
  lines.push(
    `FILE_NAME('${esc(title)}','${stamp}',(''),(''),` +
      "'SCADEC_API_Ver3.10','NodeCloudICT','');",
  )
  lines.push("FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));")
  lines.push('ENDSEC;')
  lines.push('DATA;')
  let id = 10
  for (const f of [...head, ...body]) {
    lines.push(`#${id} = ${f};`)
    id += 10
  }
  lines.push('ENDSEC;')
  lines.push('END-ISO-10303-21;')
  return lines.join('\r\n') + '\r\n'
}

const esc = (s: string) => s.replace(/'/g, "''")

/** 名前 に 使えない 文字 を 落とす */
export function safeFileName(s: string): string {
  return (s || '図面').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/** 作った ファイル を 保存 させる */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
