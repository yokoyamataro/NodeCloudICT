// 立入通知書（境界測量のご連絡及び境界立会のお願い）の docx を生成する。
// docx npm ライブラリでプログラマ的にレイアウトを組み立て、Blob → ダウンロード。
//
// テンプレートは添付の Word ファイルに合わせた 3 セクション構成:
//   1. ヘッダー: 発行日 + 事務所ブロック（郵便番号 / 住所 / 事務所名 / 資格・氏名 / TEL・FAX / 携帯）
//   2. 本文:    タイトル + 定型文
//   3. 明細:    依頼人 / 測量する土地 / 隣接する土地 / お願い文

import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  BorderStyle,
} from 'docx'
import type { DocumentSettings } from '@/types/database'

export interface EntryNoticeInput {
  /** 発行日（省略時は今日） */
  issuedAt?: Date
  /** 依頼人（地権者管理から選択された 1 名） */
  client: {
    full_name: string
    postal_code?: string | null
    address?: string | null
  }
  /** 隣接する土地の所有者（0 名以上） */
  neighbors: Array<{
    full_name: string
    postal_code?: string | null
    address?: string | null
    /** その隣接者の宛先として使いたい場合は宛名（未指定なら full_name） */
    parcel_label?: string | null
  }>
  /** 「測量する土地」欄。省略時は既定文言 */
  landDescription?: string
  /** 事務所情報（profiles.document_settings.office） */
  office: NonNullable<DocumentSettings['office']>
  /** 差出人の宛名（受け取り側の氏名。今回宛てて発行するときは client.full_name か 隣接者名を渡す） */
  addressee?: string
}

// 和暦（令和）表記
function formatWareki(d: Date): string {
  // 令和は 2019-05-01 以降。それ以前は年号未対応（普通に西暦を返す）。
  const reiwaStart = new Date(2019, 4, 1).getTime()
  if (d.getTime() < reiwaStart) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  }
  const era = d.getFullYear() - 2018
  return `令和${era === 1 ? '元' : era}年${d.getMonth() + 1}月${d.getDate()}日`
}

const FONT = 'MS Mincho' // Word 標準の和文フォント。無ければ Word 側で置換される。

function line(
  text = '',
  opts: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {},
): Paragraph {
  return new Paragraph({
    alignment: opts.align,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        size: opts.size, // half-points
        font: FONT,
      }),
    ],
  })
}

function cellNoBorder(children: Paragraph[]): TableCell {
  return new TableCell({
    children,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
  })
}

/** docx Blob を生成して返す */
export async function buildEntryNoticeDocx(input: EntryNoticeInput): Promise<Blob> {
  const issued = input.issuedAt ?? new Date()
  const dateText = formatWareki(issued)
  const office = input.office
  const client = input.client
  const neighbors = input.neighbors ?? []
  const landDescription = input.landDescription?.trim() || '別紙位置図のとおり'
  const addressee = input.addressee?.trim() || client.full_name

  // ヘッダー: 左に addressee「〜様」、右に発行日 + 事務所情報
  // 2 列テーブルで左右を配置。
  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          cellNoBorder([
            line(''),
            line(''),
            line(`${addressee}  様`, { size: 24 }),
          ]),
          cellNoBorder([
            line(dateText, { align: AlignmentType.RIGHT, size: 22 }),
            line(''),
            line(office.postal_code ? `〒${office.postal_code}` : '', { align: AlignmentType.RIGHT, size: 22 }),
            line(office.address ?? '', { align: AlignmentType.RIGHT, size: 22 }),
            line(office.name ?? '', { align: AlignmentType.RIGHT, size: 22 }),
            line(
              [office.title, office.representative].filter(Boolean).join('  '),
              { align: AlignmentType.RIGHT, size: 24, bold: true },
            ),
            line(
              [
                office.tel ? `TEL ${office.tel}` : '',
                office.fax ? `FAX ${office.fax}` : '',
              ]
                .filter(Boolean)
                .join('   '),
              { align: AlignmentType.RIGHT, size: 20 },
            ),
            line(office.mobile ? `携帯 ${office.mobile}` : '', {
              align: AlignmentType.RIGHT,
              size: 20,
            }),
            line(office.email ? `Email ${office.email}` : '', {
              align: AlignmentType.RIGHT,
              size: 20,
            }),
            ...(office.contact_name
              ? [line(`担当: ${office.contact_name}`, { align: AlignmentType.RIGHT, size: 20 })]
              : []),
          ]),
        ],
      }),
    ],
  })

  // タイトル
  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 200 },
    children: [
      new TextRun({
        text: '境界測量のご連絡及び境界立会のお願い',
        bold: true,
        size: 32,
        font: FONT,
      }),
    ],
  })

  // 本文
  const body = [
    line(
      '　この度下記土地につきまして、境界測量を実施することとなりました。',
      { size: 22 },
    ),
    line(
      'つきましては、境界の調査や測量作業を行うために隣接者様の土地に立ち入る場合がありますが、ご理解の程お願いいたします。',
      { size: 22 },
    ),
    line(
      '　また、隣接者様には、境界設置後に日程調整の上、立会確認をお願いしております。',
      { size: 22 },
    ),
    line(
      '遠隔地に居住している等により立会が困難な方には、代理人による立会または写真・図面等を送付の上で確認をお願いしております。お忙しい中恐縮ですが、ご協力の程宜しくお願いします。',
      { size: 22 },
    ),
    line('　何かご不明な点がありましたら当事務所まで問い合わせください。', { size: 22 }),
    line(''),
  ]

  // 明細テーブル（依頼人 / 測量する土地 / 隣接する土地）
  const clientLines: Paragraph[] = [
    line(
      client.address
        ? `住所　${client.postal_code ? `〒${client.postal_code}　` : ''}${client.address}`
        : '住所',
      { size: 22 },
    ),
    line(`氏名　${client.full_name || ''}`, { size: 22 }),
  ]

  const neighborLines: Paragraph[] =
    neighbors.length === 0
      ? [line('（該当なし）', { size: 22 })]
      : neighbors.map((n) => {
          const parts: string[] = []
          if (n.parcel_label) parts.push(n.parcel_label)
          parts.push(n.full_name || '')
          if (n.address) parts.push(n.address)
          return line('・' + parts.filter(Boolean).join('　'), { size: 22 })
        })

  const buildLabelRow = (label: string, content: Paragraph[]): TableRow =>
    new TableRow({
      children: [
        new TableCell({
          width: { size: 22, type: WidthType.PERCENTAGE },
          children: [line(`【${label}】`, { bold: true, size: 22 })],
        }),
        new TableCell({
          width: { size: 78, type: WidthType.PERCENTAGE },
          children: content,
        }),
      ],
    })

  const detailTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      buildLabelRow('依頼人', clientLines),
      buildLabelRow('測量する土地', [line(landDescription, { size: 22 })]),
      buildLabelRow('隣接する土地', neighborLines),
    ],
  })

  // お願い文（枠付き）
  const askBox = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              line(
                `【お願い】境界立会の日程調整のため、この書類を受け取りましたらお手数ですが当事務所までご連絡をお願いします。${
                  office.tel ? `TEL:${office.tel}` : ''
                }`,
                { size: 20 },
              ),
              line('（当事務所職員より対面で受け取った場合はご連絡不要です）', {
                size: 20,
              }),
            ],
          }),
        ],
      }),
    ],
  })

  const doc = new Document({
    creator: office.name || office.representative || 'NodeCloud',
    title: '境界測量のご連絡及び境界立会のお願い',
    numbering: {
      config: [
        {
          reference: 'default-list',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1000,
              right: 1000,
              bottom: 1000,
              left: 1000,
            },
          },
        },
        children: [
          headerTable,
          line(''),
          title,
          ...body,
          detailTable,
          line(''),
          askBox,
        ],
      },
    ],
  })

  return await Packer.toBlob(doc)
}

/** Blob をブラウザでダウンロードさせる */
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
