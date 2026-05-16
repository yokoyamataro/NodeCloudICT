// 撮影写真をブラウザ側で長辺指定 + JPEG 品質指定でリサイズする。
// モバイルからの巨大画像（10MB+）をそのままアップロードしないための前処理。

export interface ResizeOptions {
  /** リサイズ後の長辺サイズ（px）。元画像が小さければ拡大はしない。 */
  maxSize?: number
  /** JPEG 品質 0..1 */
  quality?: number
  /** 出力 MIME（既定 image/jpeg） */
  mime?: 'image/jpeg' | 'image/webp'
}

export interface ResizedImage {
  blob: Blob
  width: number
  height: number
  mime: string
}

/** File / Blob → リサイズ済み Blob */
export async function resizeImage(
  source: File | Blob,
  opts: ResizeOptions = {},
): Promise<ResizedImage> {
  const { maxSize = 1600, quality = 0.8, mime = 'image/jpeg' } = opts
  const bitmap = await createImageBitmap(source)
  const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * ratio)
  const h = Math.round(bitmap.height * ratio)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D コンテキストを取得できません')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, quality),
  )
  if (!blob) throw new Error('画像のエンコードに失敗しました')
  return { blob, width: w, height: h, mime }
}
