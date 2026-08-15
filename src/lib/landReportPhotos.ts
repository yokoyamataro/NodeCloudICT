// 09 の 基準点/補助基準点/恒久的地物 に紐づく写真を Excel に埋め込むユーティリティ。
//
// テンプレの 印刷範囲内の セルに {{ANCHOR:PHOTOS}} を配置すると、
// そのセルを 左上として グリッド状に写真が並ぶ。
// 写真の下に 「点名: XX」 のキャプション行を出す。

import type ExcelJS from 'exceljs'
import { supabase } from '@/lib/supabase'
import type {
  ReportBasePoint,
  ReportPermanentFeature,
} from '@/stores/landReportStore'

/** 写真セット (座標に紐づく) の 1 件 */
export interface PhotoItem {
  attachment: RawAttachment
  pointName: string
  section: string
}

/** ブロック内 スロット位置 (テンプレ内の相対 offset) */
export interface PhotoSlot {
  slotIdx: number  // 1-indexed
  rowOffset: number
  col: number
}

// レイアウト定数 (テンプレの 写真スロット構造に合わせる):
//   * 1 スロット = 「左に縦長キャプション列 + 大きな写真セル + 下に 撮影日/備考」
//   * {{ANCHOR:PHOTOS}} は Slot 1 の 写真セル (左上) に置く
//   * Slot 2 は Slot 1 の (COL_STEP) 列右
//   * 写真が > 2 枚のときは 下段に折り返し (ROW_STEP 行分)
//
// テンプレ実測に合わせた値:
//   D94 (Slot1 写真) → X94 (Slot2 写真) = 20 列間隔 (COL_STEP)
//   写真セル と 撮影日 セル の 相対位置: (行 +1, 列 +6)
//   1 スロット全体の高さ: 3 行 (写真行 + 撮影日行 + 備考行) → 折返し ROW_STEP
const PHOTO_WIDTH_PX = 280
const PHOTO_HEIGHT_PX = 210
const PHOTOS_PER_ROW = 2
const COL_STEP = 20
/** 折り返し時の行間隔 (写真 ~11 行 + 撮影日/備考 2 行) */
const ROW_STEP = 13
const DATE_ROW_OFFSET = 1
const DATE_COL_OFFSET = 6

export interface RawAttachment {
  id: string
  entity_id: string
  file_path: string
  mime: string | null
  category: string | null
  caption: string | null
  taken_at: string | null
  sort_order: number
}

/** basePoints + subBasePoints + permanentFeatures から coordinateId と対応する pointName / section を集約 */
function collectCoordSources(
  basePoints: ReportBasePoint[],
  subBasePoints: ReportBasePoint[],
  permanentFeatures: ReportPermanentFeature[],
): Array<{ coordinateId: string; pointName: string; section: string }> {
  const out: Array<{ coordinateId: string; pointName: string; section: string }> = []
  for (const p of basePoints) {
    if (p.coordinateId) out.push({ coordinateId: p.coordinateId, pointName: p.name, section: '基本三角点等' })
  }
  for (const p of subBasePoints) {
    if (p.coordinateId) out.push({ coordinateId: p.coordinateId, pointName: p.name, section: '補助基準点' })
  }
  for (const p of permanentFeatures) {
    if (p.coordinateId) out.push({ coordinateId: p.coordinateId, pointName: p.name, section: '恒久的地物' })
  }
  return out
}

async function fetchAttachmentsByCoords(
  coordinateIds: string[],
): Promise<Map<string, RawAttachment[]>> {
  const out = new Map<string, RawAttachment[]>()
  if (coordinateIds.length === 0) return out
  const { data } = await supabase
    .from('attachments')
    .select('id, entity_id, file_path, mime, category, caption, taken_at, sort_order')
    .eq('entity_type', 'coordinate')
    .in('entity_id', coordinateIds)
    .order('sort_order', { ascending: true })
  for (const row of ((data ?? []) as unknown as RawAttachment[])) {
    const list = out.get(row.entity_id) ?? []
    list.push(row)
    out.set(row.entity_id, list)
  }
  return out
}

async function downloadImage(filePath: string): Promise<ArrayBuffer | null> {
  const { data, error } = await supabase.storage
    .from('attachments')
    .createSignedUrl(filePath, 3600)
  if (error || !data?.signedUrl) return null
  try {
    const res = await fetch(data.signedUrl)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

function extFromMime(mime: string | null): 'jpeg' | 'png' | 'gif' {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/gif') return 'gif'
  return 'jpeg'
}

const PHOTO_IMG_TOKEN_RE = /\{\{PHOTO_IMG_(\d+)\}\}/

/** ブロック内の {{PHOTO_IMG_N}} スロット位置を抽出 (相対 offset)。 */
export function detectPhotoSlots(
  ws: ExcelJS.Worksheet,
  blockStart: number,
  blockEnd: number,
  extractText: (cell: ExcelJS.Cell) => string | null,
): PhotoSlot[] {
  const slots: PhotoSlot[] = []
  for (let r = blockStart; r <= blockEnd; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, colNum) => {
      const text = extractText(cell)
      if (!text) return
      const m = text.match(PHOTO_IMG_TOKEN_RE)
      if (m) {
        slots.push({
          slotIdx: parseInt(m[1], 10),
          rowOffset: r - blockStart,
          col: colNum,
        })
      }
    })
  }
  slots.sort((a, b) => a.slotIdx - b.slotIdx)
  return slots
}

/** 全写真 (basePoints + subBasePoints + permanentFeatures にリンクされた添付) を fetch */
export async function collectPhotoItems(body: {
  boundary: {
    basePoints: ReportBasePoint[]
    subBasePoints: ReportBasePoint[]
    permanentFeatures: ReportPermanentFeature[]
  }
}): Promise<PhotoItem[]> {
  const sources = collectCoordSources(
    body.boundary.basePoints,
    body.boundary.subBasePoints,
    body.boundary.permanentFeatures,
  )
  if (sources.length === 0) return []
  const coordIds = Array.from(new Set(sources.map((s) => s.coordinateId)))
  const attByCoord = await fetchAttachmentsByCoords(coordIds)
  const photos: PhotoItem[] = []
  for (const src of sources) {
    const list = attByCoord.get(src.coordinateId) ?? []
    for (const att of list) {
      photos.push({ attachment: att, pointName: src.pointName, section: src.section })
    }
  }
  return photos
}

/** 写真グループ (1 ブロック分) から PHOTO_CAP_i / PHOTO_DATE_i の値を作る */
export function photoBlockRowValues(group: PhotoItem[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (let j = 0; j < group.length; j++) {
    const p = group[j]
    const slotNum = j + 1
    const catLabel = p.attachment.category ?? ''
    values[`PHOTO_CAP_${slotNum}`] = `${p.pointName}${catLabel ? `　${catLabel}` : ''}`
    if (p.attachment.taken_at) {
      const d = new Date(p.attachment.taken_at)
      if (!isNaN(d.getTime())) {
        values[`PHOTO_DATE_${slotNum}`] =
          `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
      }
    }
  }
  return values
}

/** ブロック複製後、各ブロックコピーの スロット位置に 画像を埋め込む */
export async function embedPhotosInBlocks(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  photos: PhotoItem[],
  slots: PhotoSlot[],
  blockShiftedStart: number,
  blockHeight: number,
): Promise<number> {
  console.log('[embedPhotosInBlocks] start:', {
    blockShiftedStart, blockHeight, slotsCount: slots.length, photosCount: photos.length,
    slots: slots.map((s) => `slot${s.slotIdx}: rowOffset=${s.rowOffset}, col=${s.col}`),
  })
  if (slots.length === 0 || photos.length === 0) return 0
  const slotsPerBlock = slots.length
  const groupsCount = Math.ceil(photos.length / slotsPerBlock)
  let inserted = 0
  for (let i = 0; i < groupsCount; i++) {
    const copyStart = blockShiftedStart + i * blockHeight
    for (let j = 0; j < slotsPerBlock; j++) {
      const photoIdx = i * slotsPerBlock + j
      if (photoIdx >= photos.length) break
      const photo = photos[photoIdx]
      const buf = await downloadImage(photo.attachment.file_path)
      if (!buf) continue
      const imgId = wb.addImage({
        buffer: buf as unknown as ExcelJS.Buffer,
        extension: extFromMime(photo.attachment.mime),
      })
      const slot = slots[j]
      const targetRow = copyStart + slot.rowOffset
      console.log(`[embedPhotosInBlocks] photo[${photoIdx}] (${photo.pointName}) → group=${i} slot=${j+1} at (row=${targetRow}, col=${slot.col})`)
      ws.addImage(imgId, {
        tl: { col: slot.col - 1, row: targetRow - 1 },
        ext: { width: PHOTO_WIDTH_PX, height: PHOTO_HEIGHT_PX },
      })
      inserted++
    }
  }
  return inserted
}

/**
 * 印刷可能な 範囲内に {{ANCHOR:PHOTOS}} が置かれていれば、その位置を左上として
 * basePoints/subBasePoints/permanentFeatures にリンクされた写真を グリッド埋込。
 * 見つからなければ 何もしない。
 * トークン {{ANCHOR:PHOTOS}} は 呼出元の 全体トークン置換で 除去される。
 */
export async function embedLinkedPhotos(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  body: {
    boundary: {
      basePoints: ReportBasePoint[]
      subBasePoints: ReportBasePoint[]
      permanentFeatures: ReportPermanentFeature[]
    }
  },
  anchorRow: number,
  anchorCol: number,
): Promise<number> {
  const sources = collectCoordSources(
    body.boundary.basePoints,
    body.boundary.subBasePoints,
    body.boundary.permanentFeatures,
  )
  console.log('[embedLinkedPhotos] anchor at row', anchorRow, 'col', anchorCol)
  console.log('[embedLinkedPhotos] coord sources:', sources.length, sources.map((s) => `${s.section}:${s.pointName}=${s.coordinateId}`))
  if (sources.length === 0) {
    console.warn('[embedLinkedPhotos] 座標にリンクされた点がありません (座標から選択で取込した点が必要)')
    return 0
  }

  const coordIds = Array.from(new Set(sources.map((s) => s.coordinateId)))
  const attByCoord = await fetchAttachmentsByCoords(coordIds)
  console.log('[embedLinkedPhotos] attachments per coord:', Object.fromEntries(Array.from(attByCoord.entries()).map(([k, v]) => [k, v.length])))

  // 全写真を平坦化 (座標の 登録順 × その中の sort_order)
  const photos: PhotoItem[] = []
  for (const src of sources) {
    const list = attByCoord.get(src.coordinateId) ?? []
    for (const att of list) {
      photos.push({ attachment: att, pointName: src.pointName, section: src.section })
    }
  }
  console.log('[embedLinkedPhotos] total photos to embed:', photos.length)
  if (photos.length === 0) {
    console.warn('[embedLinkedPhotos] リンクされた座標に 写真がありません (座標管理で 写真を添付してください)')
    return 0
  }

  let inserted = 0
  let downloadFails = 0
  for (let i = 0; i < photos.length; i++) {
    const { attachment, pointName } = photos[i]
    const buf = await downloadImage(attachment.file_path)
    if (!buf) {
      downloadFails++
      console.warn('[embedLinkedPhotos] download failed for', attachment.file_path)
      continue
    }

    const imgId = wb.addImage({
      buffer: buf as unknown as ExcelJS.Buffer,
      extension: extFromMime(attachment.mime),
    })

    const gridRow = Math.floor(i / PHOTOS_PER_ROW)
    const gridCol = i % PHOTOS_PER_ROW
    // 写真セル (「大きな写真エリア」) の 1-indexed 行/列
    const photoRow = anchorRow + gridRow * ROW_STEP
    const photoCol = anchorCol + gridCol * COL_STEP
    // addImage の tl は 0-indexed
    ws.addImage(imgId, {
      tl: { col: photoCol - 1, row: photoRow - 1 },
      ext: { width: PHOTO_WIDTH_PX, height: PHOTO_HEIGHT_PX },
    })

    // キャプション: 写真の 左隣のセル (縦長) に 「点名 分類」を 縦書きで挿入
    const capCell = ws.getCell(photoRow, photoCol - 1)
    const catLabel = attachment.category ?? ''
    capCell.value = `${pointName}${catLabel ? `　${catLabel}` : ''}`
    capCell.font = { size: 10 }
    capCell.alignment = {
      ...(capCell.alignment ?? {}),
      vertical: 'middle',
      horizontal: 'center',
      textRotation: 255, // Excel の縦書き (日本語 上→下)
      wrapText: true,
    }

    // 撮影日: 写真の下の 「撮影年月日」ラベル右のセル (テンプレの相対位置)
    if (attachment.taken_at) {
      const d = new Date(attachment.taken_at)
      if (!isNaN(d.getTime())) {
        const dateCell = ws.getCell(photoRow + DATE_ROW_OFFSET, photoCol + DATE_COL_OFFSET)
        const dateStr = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
        dateCell.value = dateStr
        if (!dateCell.font) dateCell.font = { size: 10 }
      }
    }

    inserted++
  }
  console.log('[embedLinkedPhotos] inserted:', inserted, '/', photos.length, downloadFails > 0 ? `(download failures: ${downloadFails})` : '')
  return inserted
}
