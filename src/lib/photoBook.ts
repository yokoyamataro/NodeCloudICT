// 写真帳（遠景・近景などの写真を貼り付けた Excel）を生成する。
// 画像は exceljs で埋め込み、ブラウザでダウンロード可能な Blob を返す。
// レイアウトは事前登録した「ひな形（テンプレート）」から選択できる。
import ExcelJS from 'exceljs'

export interface PhotoBookPhoto {
  category: string
  caption: string | null
  takenAt: string | null
  filePath: string
}

export interface PhotoBookPoint {
  name: string
  /** 点種名など補足（ヘッダに括弧書き） */
  subtitle?: string
  /** 杭種（標準ひな形のメタ行に表示） */
  stakeType?: string | null
  /** 設置状況ラベル（標準ひな形のメタ行に表示） */
  stakeStatus?: string | null
  photos: PhotoBookPhoto[]
}

// 事前登録するひな形
export interface PhotoBookTemplate {
  id: string
  label: string
  description: string
  /** 1 段に並べる写真枚数 */
  perRow: number
  /** 画像サイズ(px) */
  imgW: number
  imgH: number
  /** 1 点ごとに改ページする */
  pageBreakPerPoint: boolean
}

export const PHOTO_BOOK_TEMPLATES: PhotoBookTemplate[] = [
  {
    id: 'standard',
    label: '標準（遠景・近景 2列）',
    description: '1点ごとに写真を2枚横並び。複数点を連続して掲載します。',
    perRow: 2,
    imgW: 320,
    imgH: 240,
    pageBreakPerPoint: false,
  },
  {
    id: 'large',
    label: '大判（2列・大きめ）',
    description: '写真を大きく表示（440×330）。確認用に見やすいレイアウト。',
    perRow: 2,
    imgW: 440,
    imgH: 330,
    pageBreakPerPoint: false,
  },
  {
    id: 'grid3',
    label: '一覧（3枚/段・小）',
    description: '1段に3枚（240×180）。多数の写真をコンパクトに掲載します。',
    perRow: 3,
    imgW: 240,
    imgH: 180,
    pageBreakPerPoint: false,
  },
  {
    id: 'perPoint',
    label: '1点1ページ（提出用）',
    description: '1点ごとに改ページ。提出用に体裁を整えます。',
    perRow: 2,
    imgW: 360,
    imgH: 270,
    pageBreakPerPoint: true,
  },
]

export interface PhotoBookOptions {
  title: string
  subtitle?: string
  points: PhotoBookPoint[]
  template: PhotoBookTemplate
  /** filePath から画像バイト列を取得（署名URL等で）。失敗時 null */
  resolveImage: (filePath: string) => Promise<ArrayBuffer | null>
  onProgress?: (done: number, total: number) => void
}

function abToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function extOf(filePath: string): 'png' | 'jpeg' {
  return filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 年月日のみ（時刻なし）
function fmtDateOnly(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

export async function generatePhotoBookExcel(opts: PhotoBookOptions): Promise<Blob> {
  const { template: tpl } = opts
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('写真帳')

  // 画像列（imgcol）とギャップ列を交互に配置: imgcol = 0,2,4...（0-based）
  const colWidthChars = Math.ceil(tpl.imgW / 7) + 1
  for (let k = 0; k < tpl.perRow; k++) {
    ws.getColumn(k * 2 + 1).width = colWidthChars
    if (k < tpl.perRow - 1) ws.getColumn(k * 2 + 2).width = 2
  }
  const lastColIdx = (tpl.perRow - 1) * 2 + 1
  const lastColLetter = ws.getColumn(lastColIdx).letter
  // 画像 1 枚分として確保する行数（既定行高 ≒ 18px 換算 + 余白）
  const IMG_ROWS = Math.ceil(tpl.imgH / 18) + 1

  let r = 1
  ws.getCell(`A${r}`).value = opts.title
  ws.getCell(`A${r}`).font = { bold: true, size: 14 }
  r++
  if (opts.subtitle) {
    ws.getCell(`A${r}`).value = opts.subtitle
    ws.getCell(`A${r}`).font = { size: 10, color: { argb: 'FF777777' } }
    r++
  }
  r++ // 余白

  const total = opts.points.reduce((s, p) => s + p.photos.length, 0)
  let done = 0
  opts.onProgress?.(0, total)

  // 'standard' ひな形は専用レイアウト:
  //   ヘッダ: 点名（点種）
  //   1行目: 杭種　/　設置状況
  //   2行目〜: 写真（横 perRow 列）
  //   写真下: 撮影年月日（時刻なし）
  //   その下: 備考
  const isStandard = tpl.id === 'standard'

  for (let pi = 0; pi < opts.points.length; pi++) {
    const point = opts.points[pi]
    // 点ヘッダ
    ws.mergeCells(`A${r}:${lastColLetter}${r}`)
    const hc = ws.getCell(`A${r}`)
    hc.value = point.subtitle ? `${point.name}（${point.subtitle}）` : point.name
    hc.font = { bold: true, size: 12 }
    hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
    r++

    if (isStandard) {
      // メタ行（杭種 / 設置状況）— 全列をマージして 1 行で表示
      ws.mergeCells(`A${r}:${lastColLetter}${r}`)
      const meta = ws.getCell(`A${r}`)
      const stakeType = point.stakeType?.trim() || '—'
      const stakeStatus = point.stakeStatus?.trim() || '—'
      meta.value = `杭種: ${stakeType}　／　設置状況: ${stakeStatus}`
      meta.font = { size: 10 }
      r++
    }

    const photos = point.photos
    for (let i = 0; i < photos.length; i += tpl.perRow) {
      const rowPhotos = photos.slice(i, i + tpl.perRow)

      if (!isStandard) {
        // 既存ひな形: 画像の上にカテゴリ + 日時のラベル行
        rowPhotos.forEach((ph, j) => {
          const cell = ws.getCell(r, j * 2 + 1)
          cell.value = `${ph.category}${ph.takenAt ? '　' + fmtDate(ph.takenAt) : ''}`
          cell.font = { bold: true, size: 10 }
        })
      } else {
        // 標準ひな形: 画像の上はカテゴリ名のみ（遠景 / 近景 等）
        rowPhotos.forEach((ph, j) => {
          const cell = ws.getCell(r, j * 2 + 1)
          cell.value = ph.category
          cell.font = { bold: true, size: 10 }
        })
      }
      const imgRow0 = r // 0-based アンカー → ラベル行の下に画像が出る

      for (let j = 0; j < rowPhotos.length; j++) {
        const ph = rowPhotos[j]
        const buf = await opts.resolveImage(ph.filePath)
        done++
        opts.onProgress?.(done, total)
        if (buf) {
          const id = wb.addImage({ base64: abToBase64(buf), extension: extOf(ph.filePath) })
          ws.addImage(id, {
            tl: { col: j * 2, row: imgRow0 },
            ext: { width: tpl.imgW, height: tpl.imgH },
            editAs: 'oneCell',
          })
        } else {
          ws.getCell(r + 1, j * 2 + 1).value = '(画像取得失敗)'
        }
      }

      r += IMG_ROWS

      if (isStandard) {
        // 撮影年月日（時刻なし）
        rowPhotos.forEach((ph, j) => {
          const cell = ws.getCell(r, j * 2 + 1)
          cell.value = ph.takenAt ? `撮影: ${fmtDateOnly(ph.takenAt)}` : '撮影: —'
          cell.font = { size: 9 }
        })
        r++
        // 備考
        rowPhotos.forEach((ph, j) => {
          const cell = ws.getCell(r, j * 2 + 1)
          cell.value = ph.caption ? `備考: ${ph.caption}` : '備考:'
          cell.font = { size: 9, color: { argb: 'FF555555' } }
        })
        r += 2 // 余白
      } else {
        // 既存ひな形: キャプション行のみ
        rowPhotos.forEach((ph, j) => {
          if (ph.caption) {
            const cell = ws.getCell(r, j * 2 + 1)
            cell.value = ph.caption
            cell.font = { size: 9 }
          }
        })
        r += 2 // 余白
      }
    }

    if (tpl.pageBreakPerPoint && pi < opts.points.length - 1) {
      try {
        // exceljs: 行に水平改ページを設定
        ;(ws.getRow(r) as unknown as { addPageBreak?: () => void }).addPageBreak?.()
      } catch {
        /* 改ページ未対応環境は無視 */
      }
    }
    r += 1 // 点間の余白
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
