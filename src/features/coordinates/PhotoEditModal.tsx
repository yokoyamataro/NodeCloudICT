// 撮影／選択した写真の回転とトリミングを行うモーダル
// 確定で 回転 + トリミング を Canvas に焼き付けた Blob を返す。

import { useEffect, useRef, useState } from 'react'
import ReactCrop, { type Crop, type PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { RotateCcw, RotateCw, X, Check, Loader2 } from 'lucide-react'

interface PhotoEditModalProps {
  file: File
  onCancel: () => void
  /** 編集結果の Blob と元のファイル名を返す */
  onConfirm: (blob: Blob, fileName: string) => void
  /** ヘッダ右に出す注記（カテゴリ名、残り枚数など） */
  headerNote?: string
}

export function PhotoEditModal({ file, onCancel, onConfirm, headerNote }: PhotoEditModalProps) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [rotation, setRotation] = useState(0) // 度数（90 単位）
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null)
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // 初期トリミング: 中央に画像全体
  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget
    const initial = centerCrop(
      makeAspectCrop({ unit: '%', width: 100 }, width / height, width, height),
      width,
      height,
    )
    setCrop(initial)
  }

  const handleRotate = (delta: 90 | -90) => {
    setRotation((r) => (((r + delta) % 360) + 360) % 360)
    // 回転後はクロップが画像範囲外になりやすいのでリセット
    setCrop(undefined)
    setCompletedCrop(null)
  }

  const handleConfirm = async () => {
    if (!imgRef.current) return
    setBusy(true)
    try {
      const img = imgRef.current
      const naturalW = img.naturalWidth
      const naturalH = img.naturalHeight

      // 表示サイズ → ナチュラルサイズへの倍率
      const scaleX = naturalW / img.width
      const scaleY = naturalH / img.height

      // クロップ未指定なら全画像を出力
      const cropPx = completedCrop ?? {
        x: 0,
        y: 0,
        width: img.width,
        height: img.height,
        unit: 'px' as const,
      }
      // ナチュラル単位
      const cx = Math.round(cropPx.x * scaleX)
      const cy = Math.round(cropPx.y * scaleY)
      const cw = Math.round(cropPx.width * scaleX)
      const ch = Math.round(cropPx.height * scaleY)

      // 回転後の出力寸法を決定し、長辺 1600px に縮小（モバイルでの canvas/encode 負荷低減）
      const isQuarterTurn = rotation === 90 || rotation === 270
      const finalW = isQuarterTurn ? ch : cw
      const finalH = isQuarterTurn ? cw : ch
      const MAX_LONG_EDGE = 1600
      const scale = Math.min(1, MAX_LONG_EDGE / Math.max(finalW, finalH))
      const outW = Math.max(1, Math.round(finalW * scale))
      const outH = Math.max(1, Math.round(finalH * scale))

      // ブラウザの hardware decode を活かして元 File から「クロップ＋縮小」を 1 ステップで実施。
      // resizeWidth/Height は回転前のサイズに合わせる（回転後に outW/outH になる）
      const preRotateW = isQuarterTurn ? outH : outW
      const preRotateH = isQuarterTurn ? outW : outH
      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(file, cx, cy, cw, ch, {
          resizeWidth: preRotateW,
          resizeHeight: preRotateH,
          resizeQuality: 'high',
        })
      } catch {
        // 古い iOS Safari など対応外環境では img タグから drawImage で済ます
        bitmap = await createImageBitmap(img, cx, cy, cw, ch, {
          resizeWidth: preRotateW,
          resizeHeight: preRotateH,
          resizeQuality: 'high',
        })
      }

      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D が取得できません')

      // 中心原点で回転 → 縮小済み bitmap を貼り付け
      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.rotate((rotation * Math.PI) / 180)
      ctx.drawImage(bitmap, -preRotateW / 2, -preRotateH / 2)
      bitmap.close?.()

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8),
      )
      if (!blob) throw new Error('画像のエンコードに失敗しました')
      onConfirm(blob, file.name)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : '画像処理に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[95vh] flex flex-col">
        <div className="px-4 py-2 border-b flex items-center gap-2">
          <h3 className="text-base font-semibold flex-1">写真を編集</h3>
          {headerNote && (
            <span className="text-xs text-slate-500 px-2 py-0.5 rounded bg-slate-100">
              {headerNote}
            </span>
          )}
          <button
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3 bg-slate-100 flex items-center justify-center">
          {imgUrl ? (
            <ReactCrop
              crop={crop}
              onChange={(c) => setCrop(c)}
              onComplete={(c) => setCompletedCrop(c)}
              ruleOfThirds
            >
              <img
                ref={imgRef}
                src={imgUrl}
                onLoad={handleImgLoad}
                style={{
                  transform: `rotate(${rotation}deg)`,
                  maxHeight: '60vh',
                  maxWidth: '100%',
                  display: 'block',
                }}
                alt="編集中"
              />
            </ReactCrop>
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          )}
        </div>

        <div className="px-4 py-2 border-t flex items-center gap-2">
          <button
            onClick={() => handleRotate(-90)}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
            title="左 90° 回転"
          >
            <RotateCcw className="h-4 w-4" />
            左
          </button>
          <button
            onClick={() => handleRotate(90)}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
            title="右 90° 回転"
          >
            <RotateCw className="h-4 w-4" />
            右
          </button>
          <span className="ml-2 text-xs text-slate-500 truncate flex-1">
            ドラッグでトリミング枠を指定（指定なしは全体）
          </span>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            取り込む
          </button>
        </div>
      </div>
    </div>
  )
}
