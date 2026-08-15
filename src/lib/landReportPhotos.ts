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

// レイアウト定数 (テンプレの 写真スロット構造に合わせる):
//   * 1 スロット = 「左に縦長キャプション列 + 右に大きな写真セル」で構成
//   * 2 スロットを 1 行に並べ、写真が多ければ 下段に折り返し
//
// COL_STEP は 1 スロット全体の幅 (キャプション列 + 写真セル + 余白) を
// 想定した 列数。既定 6 列 (キャプション 1 + 写真 4-5 + 余白) 相当。
// ROW_STEP は 1 スロットの高さ (写真 + 撮影日 / 備考 の余白) を想定。
const PHOTO_WIDTH_PX = 220
const PHOTO_HEIGHT_PX = 165
const PHOTOS_PER_ROW = 2
const COL_STEP = 7
const ROW_STEP = 13

interface RawAttachment {
  id: string
  entity_id: string
  file_path: string
  mime: string | null
  category: string | null
  caption: string | null
  sort_order: number
}

interface PhotoItem {
  attachment: RawAttachment
  /** 写真の 帰属点 (点名) */
  pointName: string
  /** 分類ラベル (「基本三角点等」「補助基準点」「恒久的地物」) */
  section: string
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
    .select('id, entity_id, file_path, mime, category, caption, sort_order')
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

    inserted++
  }
  console.log('[embedLinkedPhotos] inserted:', inserted, '/', photos.length, downloadFails > 0 ? `(download failures: ${downloadFails})` : '')
  return inserted
}
