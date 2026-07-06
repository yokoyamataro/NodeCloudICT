// Word テンプレート (.docx) をロードして、プレースホルダを差し替えて Blob を返す。
// docxtemplater + pizzip のラッパー。
//
// 1 枚の Word には 依頼人 1 名 + 隣接者 1 名を差し込む方針。
// 複数隣接者を選んだ場合は呼び出し側で隣接者ごとに 1 回ずつ renderTemplate を
// 呼んで別ファイルにする (テンプレート側にループを書く必要はない)。
//
// 使えるプレースホルダ（テンプレ側で {} で囲む）:
//   {issued_date}          … 発行日 (令和X年Y月Z日)
//   {issued_ymd}           … 発行日 (YYYY-MM-DD)
//   {client_name}          … 依頼人氏名
//   {client_postal_code}   … 依頼人郵便番号
//   {client_address}       … 依頼人住所
//   {neighbor_name}        … 隣接者氏名
//   {neighbor_postal_code} … 隣接者郵便番号
//   {neighbor_address}     … 隣接者住所
//
// 事務所情報 (事務所名 / 住所 / TEL 等) はテンプレート本体に直書きする運用のため、
// 差し込み対象からは外している。旧テンプレが {office_*} を含んでいても、
// 存在する場合は空文字で置換されるので docxtemplater エラーにはならない。

import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'

/** 旧テンプレ互換用の事務所情報。省略可 (テンプレート本体に直書きが基本)。 */
interface LegacyOfficeFields {
  postal_code?: string
  address?: string
  name?: string
  title?: string
  representative?: string
  contact_name?: string
  tel?: string
  fax?: string
  mobile?: string
  email?: string
}

export interface RenderInput {
  issuedAt?: Date
  client: {
    full_name: string
    postal_code?: string | null
    address?: string | null
  }
  /** 隣接者は 1 枚あたり 1 名。未指定なら関連プレースホルダは空文字。 */
  neighbor?: {
    full_name: string
    postal_code?: string | null
    address?: string | null
  } | null
  /** 旧テンプレ互換用。省略可 */
  office?: LegacyOfficeFields
}

function formatWareki(d: Date): string {
  const reiwaStart = new Date(2019, 4, 1).getTime()
  if (d.getTime() < reiwaStart) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  }
  const era = d.getFullYear() - 2018
  return `令和${era === 1 ? '元' : era}年${d.getMonth() + 1}月${d.getDate()}日`
}

function formatYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildData(input: RenderInput): Record<string, unknown> {
  const issued = input.issuedAt ?? new Date()
  const office = input.office ?? {}
  const n = input.neighbor
  return {
    issued_date: formatWareki(issued),
    issued_ymd: formatYMD(issued),
    client_name: input.client.full_name ?? '',
    client_postal_code: input.client.postal_code ?? '',
    client_address: input.client.address ?? '',
    neighbor_name: n?.full_name ?? '',
    neighbor_postal_code: n?.postal_code ?? '',
    neighbor_address: n?.address ?? '',
    office_postal_code: office.postal_code ?? '',
    office_address: office.address ?? '',
    office_name: office.name ?? '',
    office_title: office.title ?? '',
    office_representative: office.representative ?? '',
    office_contact_name: office.contact_name ?? '',
    office_tel: office.tel ?? '',
    office_fax: office.fax ?? '',
    office_mobile: office.mobile ?? '',
    office_email: office.email ?? '',
  }
}

/**
 * テンプレート .docx (Blob/ArrayBuffer) にデータを差し込んで新しい Blob を返す。
 */
export async function renderTemplate(
  templateBlob: Blob | ArrayBuffer,
  input: RenderInput,
): Promise<Blob> {
  const buf =
    templateBlob instanceof Blob ? await templateBlob.arrayBuffer() : templateBlob
  const zip = new PizZip(buf)
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' },
  })
  doc.render(buildData(input))
  const out = doc.getZip().generate({
    type: 'blob',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  })
  return out
}

/** 利用可能なプレースホルダ一覧（UI ヘルプ用）。
 *  事務所情報はテンプレート本体に直書きする運用のため、案内から外す。
 *  隣接者を複数選んだ場合は 1 名につき 1 ファイル出力するため、ここでは単数形。 */
export const AVAILABLE_PLACEHOLDERS: Array<{ tag: string; description: string }> = [
  { tag: '{issued_date}', description: '発行日（令和X年Y月Z日）' },
  { tag: '{issued_ymd}', description: '発行日（YYYY-MM-DD）' },
  { tag: '{client_name}', description: '依頼人氏名' },
  { tag: '{client_postal_code}', description: '依頼人郵便番号' },
  { tag: '{client_address}', description: '依頼人住所' },
  { tag: '{neighbor_name}', description: '隣接者氏名' },
  { tag: '{neighbor_postal_code}', description: '隣接者郵便番号' },
  { tag: '{neighbor_address}', description: '隣接者住所' },
]

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
