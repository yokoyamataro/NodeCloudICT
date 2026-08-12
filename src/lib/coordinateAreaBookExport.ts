// 座標面積計算書 (A4 横) の Excel 出力。
// 見本レイアウト:
//   左側: 境界点 / X座標 / Y座標 / 辺長 / 方向角 / 備考 の表
//   右側: ポリゴン図 (canvas → PNG 埋め込み)
//   下 : 面積算出公式 + 面積 / 地積 のサマリ
//
// 地目 / 土地の所有者 / 所在 は今回のスコープ外 (要望通り省略)。

import ExcelJS from 'exceljs'
import type { AreaCalculationSheet } from '@/types/database'

export interface CoordinateAreaBookOptions {
  /** 平面直角座標系の系番号。ヘッダ 「世界測地系N系」 に使う (任意) */
  zoneNumber?: number | null
  /** 標高系ラベル。省略時 「(測地成果2024)」 */
  elevationLabel?: string
  /** ヘッダ右上に載せる 区域名 (例 "23-4"、任意) */
  areaLabel?: string
}

interface ComputedRow {
  label: string
  x: number
  y: number
  sideLen: number   // 次点までの辺長 (m)
  bearingDMS: string // 方向角 (D-MM-SS)
}

/** 方向角 (X=北, Y=東) を [0, 360) の DMS 文字列 "D-MM-SS" に整形 */
function bearingDegreesToDMS(deg: number): string {
  let d = ((deg % 360) + 360) % 360
  const D = Math.floor(d)
  const mF = (d - D) * 60
  const M = Math.floor(mF)
  const sF = (mF - M) * 60
  let S = Math.round(sF)
  let dd = D, mm = M
  if (S === 60) { S = 0; mm++ }
  if (mm === 60) { mm = 0; dd++ }
  if (dd === 360) dd = 0
  return `${dd}-${String(mm).padStart(2, '0')}-${String(S).padStart(2, '0')}`
}

/** ポリゴン頂点配列から 辺長 / 方向角 を含む行データを作る */
function computeRows(sheet: AreaCalculationSheet): ComputedRow[] {
  const n = sheet.rows.length
  const out: ComputedRow[] = []
  for (let i = 0; i < n; i++) {
    const cur = sheet.rows[i]
    const next = sheet.rows[(i + 1) % n]
    const dx = next.x - cur.x
    const dy = next.y - cur.y
    const sideLen = Math.sqrt(dx * dx + dy * dy)
    const bearingDeg = Math.atan2(dy, dx) * (180 / Math.PI)
    out.push({
      label: cur.point_number,
      x: cur.x,
      y: cur.y,
      sideLen,
      bearingDMS: bearingDegreesToDMS(bearingDeg),
    })
  }
  return out
}

/** ポリゴン図を canvas に描画し base64 PNG (dataURL 前置除去済) を返す。
 *  X=北, Y=東 の実測座標。canvas は X 軸右方向 = 東、Y 軸下方向 なので
 *  canvasX = padding + (p.y - minY) * scale
 *  canvasY = H - padding - (p.x - minX) * scale
 */
function renderPolygonPngBase64(
  sheet: AreaCalculationSheet,
  opts: { areaLabel?: string },
): string | null {
  if (typeof document === 'undefined') return null
  const pts = sheet.rows.map((r) => ({ label: r.point_number, x: r.x, y: r.y }))
  if (pts.length < 2) return null

  const W = 1200
  const H = 900
  const PAD = 80

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, W, H)

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)
  const scale = Math.min((W - PAD * 2) / spanY, (H - PAD * 2) / spanX)

  const toC = (x: number, y: number) => ({
    cx: PAD + (y - minY) * scale,
    cy: H - PAD - (x - minX) * scale,
  })

  // ポリゴン (閉じる)
  ctx.strokeStyle = '#111'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  const c0 = toC(pts[0].x, pts[0].y)
  ctx.moveTo(c0.cx, c0.cy)
  for (let i = 1; i < pts.length; i++) {
    const c = toC(pts[i].x, pts[i].y)
    ctx.lineTo(c.cx, c.cy)
  }
  ctx.closePath()
  ctx.stroke()

  // 頂点 (小円) + 点名ラベル
  ctx.fillStyle = '#111'
  ctx.font = '16px "Meiryo", "MS Gothic", sans-serif'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'start'
  for (const p of pts) {
    const c = toC(p.x, p.y)
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, 3.2, 0, Math.PI * 2)
    ctx.stroke()
    // ラベルは右上に少しオフセット
    ctx.fillText(p.label, c.cx + 6, c.cy - 6)
  }

  // 中央に 区域ラベル
  if (opts.areaLabel) {
    let sxSum = 0, syPtSum = 0
    for (const p of pts) {
      const c = toC(p.x, p.y)
      sxSum += c.cx
      syPtSum += c.cy
    }
    ctx.font = 'bold 22px "Meiryo", "MS Gothic", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(opts.areaLabel, sxSum / pts.length, syPtSum / pts.length)
    ctx.textAlign = 'start'
  }

  // 方位マーク (右上、簡易 N)
  const arrCX = W - 70
  const arrCY = 70
  const arrR = 30
  ctx.beginPath()
  ctx.arc(arrCX, arrCY, arrR, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(arrCX, arrCY - arrR)
  ctx.lineTo(arrCX, arrCY + arrR * 0.6)
  ctx.stroke()
  // 先端 三角 (塗り)
  ctx.beginPath()
  ctx.moveTo(arrCX, arrCY - arrR)
  ctx.lineTo(arrCX - 6, arrCY - arrR + 12)
  ctx.lineTo(arrCX + 6, arrCY - arrR + 12)
  ctx.closePath()
  ctx.fill()
  ctx.font = 'bold 16px "Meiryo", "MS Gothic", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('N', arrCX, arrCY - arrR - 5)
  ctx.textAlign = 'start'

  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** 座標面積計算書の Excel Blob を作成 */
export async function generateCoordinateAreaBookExcel(
  sheet: AreaCalculationSheet,
  options: CoordinateAreaBookOptions = {},
): Promise<Blob> {
  const zoneNumber = options.zoneNumber ?? null
  const elevationLabel = options.elevationLabel ?? '（測地成果2024）'
  const areaLabel = options.areaLabel ?? sheet.zone_number

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('座標面積計算書', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: {
        left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2,
      },
    },
  })

  // 列幅 (chars): A(境界点) B(X座標) C(Y座標) D(辺長) E(方向角) F(備考)
  //              G(gap)  H..M (ダイアグラム領域)
  ws.getColumn(1).width = 7   // 境界点
  ws.getColumn(2).width = 11  // X座標
  ws.getColumn(3).width = 11  // Y座標
  ws.getColumn(4).width = 8   // 辺長
  ws.getColumn(5).width = 10  // 方向角
  ws.getColumn(6).width = 8   // 備考
  ws.getColumn(7).width = 2   // gap
  for (let c = 8; c <= 15; c++) ws.getColumn(c).width = 10

  // ===== 1 行目: タイトル (中央) + 右上: 座標系 / 区域名 =====
  // タイトルを A1:H1 で center
  ws.mergeCells('A1:H1')
  const titleCell = ws.getCell('A1')
  titleCell.value = '座 標 面 積 計 算 書'
  titleCell.font = { size: 18, bold: true }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 30

  // 右上: I1:M1 に 座標系
  const csLabel = zoneNumber != null
    ? `世界測地系${zoneNumber}系${elevationLabel}`
    : `世界測地系${elevationLabel}`
  ws.mergeCells('I1:M1')
  const csCell = ws.getCell('I1')
  csCell.value = csLabel
  csCell.alignment = { horizontal: 'right', vertical: 'middle' }
  csCell.font = { size: 10 }

  // 2 行目: 区域名 (I2:M2)
  ws.mergeCells('I2:J2')
  const areaLabelHeaderCell = ws.getCell('I2')
  areaLabelHeaderCell.value = '区域'
  areaLabelHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' }
  areaLabelHeaderCell.font = { bold: true }
  areaLabelHeaderCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }
  ws.mergeCells('K2:M2')
  const areaLabelValueCell = ws.getCell('K2')
  areaLabelValueCell.value = areaLabel
  areaLabelValueCell.alignment = { horizontal: 'center', vertical: 'middle' }
  areaLabelValueCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }

  // ===== 表 ヘッダ (row 3) =====
  const HEADER_ROW = 3
  const headers = ['境 界 点', 'X 座 標', 'Y 座 標', '辺 長', '方 向 角', '備  考']
  headers.forEach((h, i) => {
    const c = ws.getCell(HEADER_ROW, i + 1)
    c.value = h
    c.font = { bold: true }
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' },
    }
  })
  ws.getRow(HEADER_ROW).height = 22

  // ===== データ行 (row 4..) =====
  const rows = computeRows(sheet)
  rows.forEach((r, i) => {
    const rowIdx = HEADER_ROW + 1 + i
    const cLabel = ws.getCell(rowIdx, 1)
    cLabel.value = r.label
    cLabel.alignment = { horizontal: 'center', vertical: 'middle' }
    const cX = ws.getCell(rowIdx, 2)
    cX.value = r.x
    cX.numFmt = '0.000'
    cX.alignment = { horizontal: 'right', vertical: 'middle' }
    const cY = ws.getCell(rowIdx, 3)
    cY.value = r.y
    cY.numFmt = '0.000'
    cY.alignment = { horizontal: 'right', vertical: 'middle' }
    const cSide = ws.getCell(rowIdx, 4)
    cSide.value = r.sideLen
    cSide.numFmt = '0.000'
    cSide.alignment = { horizontal: 'right', vertical: 'middle' }
    const cBearing = ws.getCell(rowIdx, 5)
    cBearing.value = r.bearingDMS
    cBearing.alignment = { horizontal: 'center', vertical: 'middle' }
    const cNote = ws.getCell(rowIdx, 6)
    cNote.value = ''
    cNote.alignment = { horizontal: 'center', vertical: 'middle' }
    for (let c = 1; c <= 6; c++) {
      const cell = ws.getCell(rowIdx, c)
      cell.font = { size: 10 }
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
      }
    }
  })

  // ===== ダイアグラム (右側 H2..M) =====
  const png = renderPolygonPngBase64(sheet, { areaLabel })
  if (png) {
    const imgId = wb.addImage({ base64: png, extension: 'png' })
    // Anchor: 0-based row 2 (=Excel row 3), col 7 (=H)
    ws.addImage(imgId, {
      tl: { col: 7, row: 2 },
      ext: { width: 640, height: 480 },
      editAs: 'oneCell',
    })
  }

  // ===== 面積算出公式 + 面積 / 地積 (下) =====
  const bottomStart = HEADER_ROW + 1 + rows.length + 1
  // 面積算出公式 (A..C 結合)
  ws.mergeCells(bottomStart, 1, bottomStart, 3)
  const formulaCell = ws.getCell(bottomStart, 1)
  formulaCell.value = '面積算出公式:  A = 1/2 |Σ Xn × (Yn+1 − Yn−1)|'
  formulaCell.font = { size: 10 }
  formulaCell.alignment = { horizontal: 'left', vertical: 'middle' }

  // 面 積
  const areaRow = bottomStart + 1
  const areaLabelCell = ws.getCell(areaRow, 1)
  areaLabelCell.value = '面  積'
  areaLabelCell.font = { bold: true }
  areaLabelCell.alignment = { horizontal: 'center', vertical: 'middle' }
  areaLabelCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }
  ws.mergeCells(areaRow, 2, areaRow, 5)
  const areaValueCell = ws.getCell(areaRow, 2)
  areaValueCell.value = sheet.area_sqm
  areaValueCell.numFmt = '0.0000000'
  areaValueCell.alignment = { horizontal: 'right', vertical: 'middle' }
  areaValueCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }

  // 地 積 (整数 m²)
  const jichiRow = bottomStart + 2
  const jichiLabelCell = ws.getCell(jichiRow, 1)
  jichiLabelCell.value = '地  積'
  jichiLabelCell.font = { bold: true }
  jichiLabelCell.alignment = { horizontal: 'center', vertical: 'middle' }
  jichiLabelCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }
  ws.mergeCells(jichiRow, 2, jichiRow, 5)
  const jichiValueCell = ws.getCell(jichiRow, 2)
  jichiValueCell.value = Math.floor(sheet.area_sqm)
  jichiValueCell.numFmt = '0'
  jichiValueCell.alignment = { horizontal: 'right', vertical: 'middle' }
  jichiValueCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
