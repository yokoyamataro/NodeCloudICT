// Word テンプレート (.docx) をロードして、プレースホルダを差し替えて Blob を返す。
// docxtemplater + pizzip のラッパー。
//
// 使えるプレースホルダ（テンプレ側で {} で囲む）:
//   {issued_date}      … 発行日 (令和X年Y月Z日)
//   {issued_ymd}       … 発行日 (YYYY-MM-DD)
//   {client_name}       … 依頼人氏名
//   {client_postal_code} … 依頼人郵便番号
//   {client_address}    … 依頼人住所
//   {neighbors_names}   … 隣接者名を「、」区切り
//   {neighbors_lines}   … 隣接者を 1 名 1 行（氏名 + 住所）
//
// 事務所情報 (事務所名 / 住所 / TEL 等) はテンプレート本体に直書きする運用のため、
// 差し込み対象からは外している。旧テンプレが {office_*} を含んでいても、
// 存在する場合は空文字で置換されるので docxtemplater エラーにはならない。
//
// 加えて docxtemplater のループ構文もそのまま利用可能:
//   {#neighbors}・{name} {address}{/neighbors}
//   ループ内で使える keys: name, postal_code, address

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
  neighbors: Array<{
    full_name: string
    postal_code?: string | null
    address?: string | null
  }>
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
  const neighborsForLoop = input.neighbors.map((n) => ({
    name: n.full_name ?? '',
    postal_code: n.postal_code ?? '',
    address: n.address ?? '',
  }))
  const neighbors_lines = neighborsForLoop
    .map((n) => (n.address ? `${n.name}　${n.address}` : n.name))
    .join('\n')
  const neighbors_names = neighborsForLoop.map((n) => n.name).join('、')
  return {
    issued_date: formatWareki(issued),
    issued_ymd: formatYMD(issued),
    client_name: input.client.full_name ?? '',
    client_postal_code: input.client.postal_code ?? '',
    client_address: input.client.address ?? '',
    neighbors: neighborsForLoop,
    neighbors_names,
    neighbors_lines,
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
 *  事務所情報はテンプレート本体に直書きする運用のため、案内から外す。 */
export const AVAILABLE_PLACEHOLDERS: Array<{ tag: string; description: string }> = [
  { tag: '{issued_date}', description: '発行日（令和X年Y月Z日）' },
  { tag: '{issued_ymd}', description: '発行日（YYYY-MM-DD）' },
  { tag: '{client_name}', description: '依頼人氏名' },
  { tag: '{client_postal_code}', description: '依頼人郵便番号' },
  { tag: '{client_address}', description: '依頼人住所' },
  { tag: '{neighbors_names}', description: '隣接者名を「、」区切り' },
  { tag: '{neighbors_lines}', description: '隣接者を 1 名 1 行（氏名+住所）' },
  { tag: '{#neighbors}...{name} {address}...{/neighbors}', description: '隣接者のループ（name / postal_code / address）' },
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
