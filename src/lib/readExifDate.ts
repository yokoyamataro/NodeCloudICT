// JPEG の EXIF から撮影日時 (DateTimeOriginal / DateTime) と GPS 情報
// (GPSLatitude / GPSLongitude / GPSImgDirection) を読み取る軽量パーサ。
// 外部ライブラリは使わず、先頭 128KB だけ走査する。

export interface ExifGps {
  /** WGS84 緯度 (北緯 +, 南緯 -)。読めなければ null */
  lat: number | null
  /** WGS84 経度 (東経 +, 西経 -)。読めなければ null */
  lng: number | null
  /** 撮影方向 0..360 度（0=北, 90=東 ...）。読めなければ null */
  headingDeg: number | null
}

const EMPTY_GPS: ExifGps = { lat: null, lng: null, headingDeg: null }

// 旧 API: 撮影日時だけ欲しいケース用
export async function readExifDate(file: File | Blob): Promise<Date | null> {
  const meta = await readExifMetadata(file)
  return meta?.date ?? null
}

// 新 API: GPS 情報だけ欲しいケース用
export async function readExifGps(file: File | Blob): Promise<ExifGps> {
  const meta = await readExifMetadata(file)
  return meta?.gps ?? EMPTY_GPS
}

// 一括取得（一度のファイル読み込みで両方返す）
export async function readExifMetadata(file: File | Blob): Promise<{
  date: Date | null
  gps: ExifGps
} | null> {
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
          const result: { date: Date | null; gps: ExifGps } = {
            date: null,
            gps: { ...EMPTY_GPS },
          }
          walkIfd(view, tiff, ifd0, le, result)
          return result
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

// IFD を再帰的に歩いて、見つけたタグから date / gps を埋める。
function walkIfd(
  view: DataView,
  tiffBase: number,
  ifdOffset: number,
  le: boolean,
  out: { date: Date | null; gps: ExifGps },
): void {
  if (ifdOffset + 2 > view.byteLength) return
  const count = view.getUint16(ifdOffset, le)
  let exifSubIfd: number | null = null
  let gpsIfd: number | null = null
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > view.byteLength) break
    const tag = view.getUint16(entry, le)
    switch (tag) {
      // 0x8769 = Exif SubIFD ポインタ
      case 0x8769:
        exifSubIfd = tiffBase + view.getUint32(entry + 8, le)
        break
      // 0x8825 = GPS IFD ポインタ
      case 0x8825:
        gpsIfd = tiffBase + view.getUint32(entry + 8, le)
        break
      // 0x9003 = DateTimeOriginal (EXIF SubIFD 内が標準だが IFD0 にも稀にある)
      // 0x0132 = DateTime (IFD0)。DateTimeOriginal が無いときのフォールバック
      case 0x9003:
      case 0x0132: {
        const d = readAsciiDate(view, tiffBase, entry, le)
        if (d && tag === 0x9003) out.date = d
        if (d && tag === 0x0132 && !out.date) out.date = d
        break
      }
      // GPS タグ群（GPS IFD 内）
      case 0x0001: // GPSLatitudeRef ('N' / 'S')
      case 0x0002: // GPSLatitude (3 rationals)
      case 0x0003: // GPSLongitudeRef ('E' / 'W')
      case 0x0004: // GPSLongitude (3 rationals)
      case 0x0010: // GPSImgDirectionRef ('T' / 'M')
      case 0x0011: // GPSImgDirection (1 rational)
        readGpsTag(view, tiffBase, entry, le, tag, out.gps)
        break
    }
  }
  if (exifSubIfd != null) walkIfd(view, tiffBase, exifSubIfd, le, out)
  if (gpsIfd != null) walkIfd(view, tiffBase, gpsIfd, le, out)
}

function readGpsTag(
  view: DataView,
  tiffBase: number,
  entry: number,
  le: boolean,
  tag: number,
  out: ExifGps,
): void {
  const type = view.getUint16(entry + 2, le)
  const count = view.getUint32(entry + 4, le)

  if (tag === 0x0001 || tag === 0x0003 || tag === 0x0010) {
    // ASCII (type 2) 1 文字。値は inline (4 バイトに収まる)
    if (type !== 2) return
    const ch = String.fromCharCode(view.getUint8(entry + 8))
    if (tag === 0x0001) {
      // GPSLatitudeRef を一旦保持。lat の符号反転は readLat で実施する都合上、
      // ここでは latRef を out._latRef のように持ちたいが ExifGps に項目を
      // 増やしたくないので out.lat に符号を後で適用する戦略をとる。
      // → walkIfd 内で実際の lat を読んだあとに ref を適用する仕組みが必要。
      // 簡易化のため、lat / lng が読まれていれば 符号を ref で更新する。
      if (ch === 'S' && out.lat != null && out.lat > 0) out.lat = -out.lat
      // 後で lat が読まれたときのために null セーフでも処理する
      ;(out as ExifGps & { _latRef?: string })._latRef = ch
    } else if (tag === 0x0003) {
      if (ch === 'W' && out.lng != null && out.lng > 0) out.lng = -out.lng
      ;(out as ExifGps & { _lngRef?: string })._lngRef = ch
    } else if (tag === 0x0010) {
      // GPSImgDirectionRef ('T' = True north, 'M' = Magnetic north).
      // どちらでも度数として保存する（真北/磁北の補正は本アプリでは無視）。
      // 何もしない（heading 値自体は 0x0011 で読む）。
    }
    return
  }

  if (tag === 0x0002 || tag === 0x0004) {
    // RATIONAL (type 5) x 3 = 24 バイト → 必ずオフセット参照
    if (type !== 5 || count < 3) return
    const dataPos = tiffBase + view.getUint32(entry + 8, le)
    if (dataPos + 24 > view.byteLength) return
    const deg = readRational(view, dataPos, le)
    const min = readRational(view, dataPos + 8, le)
    const sec = readRational(view, dataPos + 16, le)
    if (deg == null || min == null || sec == null) return
    const dec = deg + min / 60 + sec / 3600
    if (tag === 0x0002) {
      out.lat = dec
      // 既に ref が来ていれば符号を適用
      const r = (out as ExifGps & { _latRef?: string })._latRef
      if (r === 'S') out.lat = -dec
    } else {
      out.lng = dec
      const r = (out as ExifGps & { _lngRef?: string })._lngRef
      if (r === 'W') out.lng = -dec
    }
    return
  }

  if (tag === 0x0011) {
    // RATIONAL (type 5) x 1 = 8 バイト → 必ずオフセット参照
    if (type !== 5 || count < 1) return
    const dataPos = tiffBase + view.getUint32(entry + 8, le)
    if (dataPos + 8 > view.byteLength) return
    const r = readRational(view, dataPos, le)
    if (r == null) return
    let v = r
    // 0..360 にクランプ
    if (Number.isFinite(v)) {
      v = ((v % 360) + 360) % 360
      out.headingDeg = v
    }
  }
}

function readRational(view: DataView, pos: number, le: boolean): number | null {
  if (pos + 8 > view.byteLength) return null
  const num = view.getUint32(pos, le)
  const den = view.getUint32(pos + 4, le)
  if (den === 0) return null
  return num / den
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
