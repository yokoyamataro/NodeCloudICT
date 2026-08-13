// 座標面積計算書 (A4 縦) の Excel 出力。
//
// レイアウト:
//   最上部:  面積計算書 (タイトル)
//            現場名 / 工区名 / 工種
//   中段上:  境界点 / X座標 / Y座標 / 辺長 / 方向角 / 備考 の表
//   中段下:  面積算出公式 + 面積 / 地積 のサマリ
//   下部  :  ポリゴン図 (canvas → PNG 埋め込み)
//
// 地目 / 土地の所有者 / 所在 は要望通り省略。

import ExcelJS from 'exceljs'
import type { AreaCalculationSheet } from '@/types/database'

export interface CoordinateAreaBookOptions {
  /** 平面直角座標系の系番号。ヘッダの座標系欄に使う (任意) */
  zoneNumber?: number | null
  /** 標高系ラベル。省略時 「(測地成果2024)」 */
  elevationLabel?: string
  /** 現場名 (プロジェクト名) */
  projectName?: string | null
  /** 工区名 (farm 名) */
  farmName?: string | null
  /** 工種 (例: 暗渠 / 客土 / 整地 / 心破土改 / 徐礫 / 線形物 …) */
  workTypeLabel?: string | null
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

  // A4 縦の下半分に置くため 横長を意識したサイズ
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

/** 座標面積計算書の Excel Blob を作成 (A4 縦) */
export async function generateCoordinateAreaBookExcel(
  sheet: AreaCalculationSheet,
  options: CoordinateAreaBookOptions = {},
): Promise<Blob> {
  const zoneNumber = options.zoneNumber ?? null
  const elevationLabel = options.elevationLabel ?? '（測地成果2024）'
  const areaLabel = options.areaLabel ?? sheet.zone_number
  const projectName = options.projectName ?? ''
  const farmName = options.farmName ?? ''
  const workTypeLabel = options.workTypeLabel ?? ''

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('座標面積計算書', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: {
        left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2,
      },
    },
  })

  // 列幅 (chars) — A4 縦 で 表 (6 列) が中央〜左寄り、右余白は少し。
  // A(境界点) B(X座標) C(Y座標) D(辺長) E(方向角) F(備考) = 表領域
  // G..H = ラベル/値 用の余白列 (地図はセルまたぎで配置)
  ws.getColumn(1).width = 8   // 境界点
  ws.getColumn(2).width = 13  // X座標
  ws.getColumn(3).width = 13  // Y座標
  ws.getColumn(4).width = 10  // 辺長
  ws.getColumn(5).width = 12  // 方向角
  ws.getColumn(6).width = 10  // 備考
  ws.getColumn(7).width = 4   // 右余白
  ws.getColumn(8).width = 4

  // border helper
  const box = () => ({
    top: { style: 'thin' as const },
    bottom: { style: 'thin' as const },
    left: { style: 'thin' as const },
    right: { style: 'thin' as const },
  })

  // ===== 1 行目: タイトル =====
  ws.mergeCells('A1:H1')
  const titleCell = ws.getCell('A1')
  titleCell.value = '面 積 計 算 書'
  titleCell.font = { size: 20, bold: true }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 32

  // ===== 2-4 行: 現場名 / 工区名 / 工種 =====
  const infoRows: Array<{ label: string; value: string }> = [
    { label: '現場名', value: projectName },
    { label: '工区名', value: farmName },
    { label: '工種', value: workTypeLabel },
  ]
  infoRows.forEach((info, i) => {
    const r = 2 + i
    // A: ラベル
    const lc = ws.getCell(r, 1)
    lc.value = info.label
    lc.font = { bold: true, size: 10 }
    lc.alignment = { horizontal: 'center', vertical: 'middle' }
    lc.border = box()
    // B..F: 値
    ws.mergeCells(r, 2, r, 6)
    const vc = ws.getCell(r, 2)
    vc.value = info.value
    vc.font = { size: 11 }
    vc.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    vc.border = box()
    ws.getRow(r).height = 20
  })

  // 右上 (G-H 上部) に 座標系 + 区域 の小さいラベル
  const csLabel = zoneNumber != null
    ? `世界測地系${zoneNumber}系${elevationLabel}`
    : `世界測地系${elevationLabel}`
  ws.mergeCells('G2:H4')
  const csCell = ws.getCell('G2')
  csCell.value = `${csLabel}\n区域: ${areaLabel}`
  csCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  csCell.font = { size: 9 }
  csCell.border = box()

  // ===== 表 ヘッダ (row 6) =====
  const HEADER_ROW = 6
  const headers = ['境 界 点', 'X 座 標', 'Y 座 標', '辺 長', '方 向 角', '備  考']
  headers.forEach((h, i) => {
    const c = ws.getCell(HEADER_ROW, i + 1)
    c.value = h
    c.font = { bold: true, size: 10 }
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    c.border = box()
  })
  ws.getRow(HEADER_ROW).height = 20

  // ===== データ行 =====
  const rows = computeRows(sheet)
  rows.forEach((r, i) => {
    const rowIdx = HEADER_ROW + 1 + i
    ws.getCell(rowIdx, 1).value = r.label
    ws.getCell(rowIdx, 1).alignment = { horizontal: 'center', vertical: 'middle' }
    ws.getCell(rowIdx, 2).value = r.x
    ws.getCell(rowIdx, 2).numFmt = '0.000'
    ws.getCell(rowIdx, 2).alignment = { horizontal: 'right', vertical: 'middle' }
    ws.getCell(rowIdx, 3).value = r.y
    ws.getCell(rowIdx, 3).numFmt = '0.000'
    ws.getCell(rowIdx, 3).alignment = { horizontal: 'right', vertical: 'middle' }
    ws.getCell(rowIdx, 4).value = r.sideLen
    ws.getCell(rowIdx, 4).numFmt = '0.000'
    ws.getCell(rowIdx, 4).alignment = { horizontal: 'right', vertical: 'middle' }
    ws.getCell(rowIdx, 5).value = r.bearingDMS
    ws.getCell(rowIdx, 5).alignment = { horizontal: 'center', vertical: 'middle' }
    ws.getCell(rowIdx, 6).value = ''
    ws.getCell(rowIdx, 6).alignment = { horizontal: 'center', vertical: 'middle' }
    for (let c = 1; c <= 6; c++) {
      const cell = ws.getCell(rowIdx, c)
      cell.font = { size: 10 }
      cell.border = box()
    }
  })

  // ===== 面積算出公式 + 面積 / 地積 =====
  const summaryStart = HEADER_ROW + 1 + rows.length + 1
  ws.mergeCells(summaryStart, 1, summaryStart, 6)
  const formulaCell = ws.getCell(summaryStart, 1)
  formulaCell.value = '面積算出公式:  A = 1/2 |Σ Xn × (Yn+1 − Yn−1)|'
  formulaCell.font = { size: 10 }
  formulaCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

  const areaRow = summaryStart + 1
  const areaLabelCell = ws.getCell(areaRow, 1)
  areaLabelCell.value = '面  積'
  areaLabelCell.font = { bold: true, size: 10 }
  areaLabelCell.alignment = { horizontal: 'center', vertical: 'middle' }
  areaLabelCell.border = box()
  ws.mergeCells(areaRow, 2, areaRow, 6)
  const areaValueCell = ws.getCell(areaRow, 2)
  areaValueCell.value = sheet.area_sqm
  areaValueCell.numFmt = '0.0000000" m²"'
  areaValueCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 }
  areaValueCell.border = box()

  const jichiRow = summaryStart + 2
  const jichiLabelCell = ws.getCell(jichiRow, 1)
  jichiLabelCell.value = '地  積'
  jichiLabelCell.font = { bold: true, size: 10 }
  jichiLabelCell.alignment = { horizontal: 'center', vertical: 'middle' }
  jichiLabelCell.border = box()
  ws.mergeCells(jichiRow, 2, jichiRow, 6)
  const jichiValueCell = ws.getCell(jichiRow, 2)
  jichiValueCell.value = Math.floor(sheet.area_sqm)
  jichiValueCell.numFmt = '0" m²"'
  jichiValueCell.alignment = { horizontal: 'right', vertical: 'middle', indent: 1 }
  jichiValueCell.border = box()

  // ===== ダイアグラム (下半分) =====
  // 表 + サマリの直下、A 列先頭からセル基準で貼り付ける。
  const mapAnchorRow0 = jichiRow + 1 // 0-based rowsIdx (Excel の 1-based では jichiRow+2 の行に見える)
  // A4 縦 印刷幅 ~ 190mm ≈ 720px 相当。地図は 720x540 程度で下に配置。
  const png = renderPolygonPngBase64(sheet, { areaLabel })
  if (png) {
    const imgId = wb.addImage({ base64: png, extension: 'png' })
    ws.addImage(imgId, {
      tl: { col: 0, row: mapAnchorRow0 },
      ext: { width: 720, height: 540 },
      editAs: 'oneCell',
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
