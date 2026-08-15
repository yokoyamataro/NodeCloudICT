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

/** 印刷可能なサイズを 目視で調整しやすいよう 定数化 */
const PHOTO_WIDTH_PX = 220
const PHOTO_HEIGHT_PX = 165
const PHOTOS_PER_ROW = 3
/** 1 枚あたりが 占めるおおよその 列数 / 行数 (Excel の既定 col/row サイズを想定) */
const COL_STEP = 4
const ROW_STEP = 13 // 写真 (約 11 行) + キャプション + 余白

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
  if (sources.length === 0) return 0

  const coordIds = Array.from(new Set(sources.map((s) => s.coordinateId)))
  const attByCoord = await fetchAttachmentsByCoords(coordIds)

  // 全写真を平坦化 (座標の 登録順 × その中の sort_order)
  const photos: PhotoItem[] = []
  for (const src of sources) {
    const list = attByCoord.get(src.coordinateId) ?? []
    for (const att of list) {
      photos.push({ attachment: att, pointName: src.pointName, section: src.section })
    }
  }
  if (photos.length === 0) return 0

  let inserted = 0
  for (let i = 0; i < photos.length; i++) {
    const { attachment, pointName, section } = photos[i]
    const buf = await downloadImage(attachment.file_path)
    if (!buf) continue

    const imgId = wb.addImage({
      buffer: buf as unknown as ExcelJS.Buffer,
      extension: extFromMime(attachment.mime),
    })

    const gridRow = Math.floor(i / PHOTOS_PER_ROW)
    const gridCol = i % PHOTOS_PER_ROW
    // addImage の tl は 0-indexed (row=0 → 行 1)
    const tlCol = anchorCol - 1 + gridCol * COL_STEP
    const tlRow = anchorRow - 1 + gridRow * ROW_STEP

    ws.addImage(imgId, {
      tl: { col: tlCol, row: tlRow },
      ext: { width: PHOTO_WIDTH_PX, height: PHOTO_HEIGHT_PX },
    })

    // キャプション (写真の下辺想定の行 + 少し) — 1-indexed で書き込み
    const capRow = anchorRow + gridRow * ROW_STEP + Math.ceil(PHOTO_HEIGHT_PX / 15) + 1
    const capCol = anchorCol + gridCol * COL_STEP
    const captionCell = ws.getCell(capRow, capCol)
    const catLabel = attachment.category ?? ''
    const captionText = `[${section}] ${pointName}${catLabel ? ` (${catLabel})` : ''}`
    captionCell.value = captionText
    captionCell.font = { size: 8 }
    captionCell.alignment = { ...(captionCell.alignment ?? {}), wrapText: true }

    inserted++
  }
  return inserted
}
