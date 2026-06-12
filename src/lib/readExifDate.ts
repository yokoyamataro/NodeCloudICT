// JPEG の EXIF から DateTimeOriginal (0x9003) を読み取って Date を返す。
// 取れなければ null。外部ライブラリは使わず、最小限のパーサで先頭 128KB だけ走査する。

export async function readExifDate(file: File | Blob): Promise<Date | null> {
  try {
    // EXIF は JPEG の APP1 セグメント (FFE1) に入っていて、ふつう先頭 64KB 以内にある。
    const head = file.slice(0, 131072)
    const buf = await head.arrayBuffer()
    const view = new DataView(buf)

    // JPEG SOI (Start of Image) チェック
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null

    let offset = 2
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset)
      // マーカは FFxx 形式。これ以外が出てきたら走査打ち切り。
      if ((marker & 0xff00) !== 0xff00) return null

      // APP1 (FFE1) を見つけたら "Exif\0\0" 識別子をチェックして TIFF へ進む
      if (marker === 0xffe1) {
        const segLen = view.getUint16(offset + 2)
        const exifStart = offset + 4
        if (
          exifStart + 6 <= view.byteLength &&
          view.getUint8(exifStart) === 0x45 && // 'E'
          view.getUint8(exifStart + 1) === 0x78 && // 'x'
          view.getUint8(exifStart + 2) === 0x69 && // 'i'
          view.getUint8(exifStart + 3) === 0x66 && // 'f'
          view.getUint8(exifStart + 4) === 0x00 &&
          view.getUint8(exifStart + 5) === 0x00
        ) {
          const tiff = exifStart + 6
          if (tiff + 8 > view.byteLength) return null
          // バイトオーダ: II = little, MM = big
          const bo = view.getUint16(tiff)
          if (bo !== 0x4949 && bo !== 0x4d4d) return null
          const le = bo === 0x4949
          const magic = view.getUint16(tiff + 2, le)
          if (magic !== 0x002a) return null
          const ifd0 = tiff + view.getUint32(tiff + 4, le)
          const d = readDateFromIfd(view, tiff, ifd0, le)
          if (d) return d
          return null
        }
        offset += 2 + segLen
        continue
      }
      // 他のマーカはサイズフィールドをスキップ
      const segLen = view.getUint16(offset + 2)
      offset += 2 + segLen
    }
    return null
  } catch {
    return null
  }
}

function readDateFromIfd(
  view: DataView,
  tiffBase: number,
  ifdOffset: number,
  le: boolean,
): Date | null {
  if (ifdOffset + 2 > view.byteLength) return null
  const count = view.getUint16(ifdOffset, le)
  let exifIfdPtr: number | null = null
  let dateTime: Date | null = null
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > view.byteLength) break
    const tag = view.getUint16(entry, le)
    // 0x8769 = Exif SubIFD ポインタ
    if (tag === 0x8769) {
      exifIfdPtr = tiffBase + view.getUint32(entry + 8, le)
    }
    // 0x9003 = DateTimeOriginal（撮影日時。EXIF SubIFD 内）
    // 0x0132 = DateTime（IFD0 にあるファイル更新日時。フォールバック）
    if (tag === 0x9003 || tag === 0x0132) {
      const d = readAsciiDate(view, tiffBase, entry, le)
      if (d && tag === 0x9003) return d
      if (d && !dateTime) dateTime = d
    }
  }
  if (exifIfdPtr != null) {
    const sub = readDateFromIfd(view, tiffBase, exifIfdPtr, le)
    if (sub) return sub
  }
  return dateTime
}

function readAsciiDate(
  view: DataView,
  tiffBase: number,
  entryOffset: number,
  le: boolean,
): Date | null {
  const type = view.getUint16(entryOffset + 2, le)
  const count = view.getUint32(entryOffset + 4, le)
  // ASCII (type 2)、"YYYY:MM:DD HH:MM:SS\0" で count = 20
  if (type !== 2 || count < 19) return null
  // 値が 4 バイトを超えるならオフセット参照、超えなければ entry の inline 値
  const dataPos = count > 4 ? tiffBase + view.getUint32(entryOffset + 8, le) : entryOffset + 8
  if (dataPos + 19 > view.byteLength) return null
  let s = ''
  for (let i = 0; i < 19; i++) s += String.fromCharCode(view.getUint8(dataPos + i))
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const d = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10),
  )
  return Number.isNaN(d.getTime()) ? null : d
}
