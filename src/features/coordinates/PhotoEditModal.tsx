// 撮影／選択した写真の回転とトリミングを行うモーダル
// 確定で 回転 + トリミング を Canvas に焼き付けた Blob と
// メタ情報（撮影日 / 備考 / 位置 / 撮影方向）を返す。
//
// 位置・方向の編集はオプション（enableLocationEdit=true で有効）。
// 「位置・方向を編集」ボタン → 内部的に地図ピッカー画面に遷移し、
// ピンの移動と方向スライダで lat/lng/heading を指定できる。

import { useEffect, useRef, useState } from 'react'
import ReactCrop, { type Crop, type PixelCrop, centerCrop, makeAspectCrop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { RotateCcw, RotateCw, X, Check, Loader2, MapPin, Compass } from 'lucide-react'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { readExifMetadata } from '@/lib/readExifDate'

export interface PhotoEditMeta {
  /** 撮影日（EXIF があれば優先。ユーザは編集可能）。null は未指定 */
  takenAt: Date | null
  /** 備考。空文字は null として扱う */
  caption: string | null
  /** 撮影位置（緯度）。enableLocationEdit が無効なら null のまま */
  lat: number | null
  /** 撮影位置（経度） */
  lng: number | null
  /** 撮影方向 0..360 度（0=北, 90=東）。指定なしは null */
  headingDeg: number | null
}

interface PhotoEditModalProps {
  file: File
  onCancel: () => void
  /** 編集結果の Blob と元のファイル名 + メタを返す */
  onConfirm: (blob: Blob, fileName: string, meta: PhotoEditMeta) => void
  /** ヘッダ右に出す注記（カテゴリ名、残り枚数など） */
  headerNote?: string
  /** 位置・方向の編集 UI を出すかどうか */
  enableLocationEdit?: boolean
  /** 初期位置・方向（取り込み直後にカメラから渡された値など） */
  initialLat?: number | null
  initialLng?: number | null
  initialHeadingDeg?: number | null
  /** 既存写真の編集時に、備考と撮影日を復元するための初期値 */
  initialCaption?: string | null
  initialTakenAt?: Date | null
}

// HTML <input type="date"> に渡す YYYY-MM-DD 文字列に変換
function toDateInputValue(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseDateInputValue(s: string): Date | null {
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  return Number.isNaN(d.getTime()) ? null : d
}

export function PhotoEditModal({
  file,
  onCancel,
  onConfirm,
  headerNote,
  enableLocationEdit = false,
  initialLat = null,
  initialLng = null,
  initialHeadingDeg = null,
  initialCaption = null,
  initialTakenAt = null,
}: PhotoEditModalProps) {
  // 「トリミング」ボタンで仮確定した中間ファイル（さらに切り直せる）を保持する。
  // 初期は props の file、「戻す」で file に戻る。「確定」時にこの workingFile と
  // 現在の crop/rotation を最終適用する。
  const [workingFile, setWorkingFile] = useState<File>(file)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [rotation, setRotation] = useState(0) // 度数（90 単位）
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null)
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  // トリミング枠のアスペクト比。ラベルは常に "短辺:長辺" で持ち、横長 / 縦長 の
  // 向きボタンでどちらを width に当てるか切り替える。既定は 横長 + 3:4（従来の
  // 4:3 相当）。
  type AspectKey = '1:1' | '2:3' | '3:4' | '9:16' | 'free'
  const [aspectKey, setAspectKey] = useState<AspectKey>('3:4')
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape')
  const aspect: number | undefined = (() => {
    if (aspectKey === 'free') return undefined
    if (aspectKey === '1:1') return 1
    const [a, b] = aspectKey.split(':').map(Number)
    // a < b。横長 = b/a、縦長 = a/b
    return orientation === 'landscape' ? b / a : a / b
  })()
  // 「トリミング」ボタンの 2 段階フロー用の状態
  //   showHandles=false, hasApplied=false → 初期。ハンドル・比率非表示、[トリミング] のみ
  //   showHandles=true,  hasApplied=false → 編集中。ハンドル・比率表示、[トリミング] で仮確定
  //   showHandles=true,  hasApplied=true  → 仮確定済。ハンドル外枠いっぱい、[戻す] で元に戻る
  const [showHandles, setShowHandles] = useState(false)
  const [hasApplied, setHasApplied] = useState(false)
  // 撮影日: 既存写真の編集なら initialTakenAt、それ以外は空。EXIF が取れれば下の
  // useEffect で上書き。EXIF が無ければ空のままにする（本日を勝手に入れない）。
  const [takenAtStr, setTakenAtStr] = useState<string>(() =>
    initialTakenAt ? toDateInputValue(initialTakenAt) : '',
  )
  const [caption, setCaption] = useState<string>(initialCaption ?? '')
  const [exifLoaded, setExifLoaded] = useState(false)
  // 位置・方向
  const [lat, setLat] = useState<number | null>(initialLat)
  const [lng, setLng] = useState<number | null>(initialLng)
  const [headingDeg, setHeadingDeg] = useState<number | null>(initialHeadingDeg)
  const [mode, setMode] = useState<'photo' | 'location'>('photo')

  // props.file が変わった (別の写真を編集し始めた) 場合はすべての中間状態をリセット
  useEffect(() => {
    setWorkingFile(file)
    setCrop(undefined)
    setCompletedCrop(null)
    setRotation(0)
    setShowHandles(false)
    setHasApplied(false)
  }, [file])

  useEffect(() => {
    const url = URL.createObjectURL(workingFile)
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [workingFile])

  // ファイルから EXIF (撮影日 + GPS 位置 + 撮影方向) を非同期で読み、取れたら反映。
  // GPS / 方向は EXIF が最優先。EXIF 読み取りは元 file だけを対象にする
  // （workingFile はキャンバス生成の JPEG で EXIF は残っていないため）。
  useEffect(() => {
    let cancelled = false
    setExifLoaded(false)
    void readExifMetadata(file).then((meta) => {
      if (cancelled || !meta) {
        if (!cancelled) setExifLoaded(true)
        return
      }
      if (meta.date) setTakenAtStr(toDateInputValue(meta.date))
      if (meta.gps.lat != null && meta.gps.lng != null) {
        setLat(meta.gps.lat)
        setLng(meta.gps.lng)
      }
      if (meta.gps.headingDeg != null) setHeadingDeg(meta.gps.headingDeg)
      setExifLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [file])

  // 画像 load 時のクロップ初期化:
  //   仮確定直後 (hasApplied) は外枠いっぱい 100%
  //   編集中 (showHandles) は 現在の aspect で 90% 中央
  //   それ以外 (初期状態) はハンドルが出ないので何もしない
  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!showHandles) return
    const { width, height } = e.currentTarget
    if (hasApplied) {
      setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 })
      return
    }
    const ar = aspect ?? width / height
    const initial = centerCrop(
      makeAspectCrop({ unit: '%', width: 90 }, ar, width, height),
      width,
      height,
    )
    setCrop(initial)
  }

  // aspect が変わったらクロップを再設定（編集中のみ）
  useEffect(() => {
    if (!showHandles || hasApplied) return
    const img = imgRef.current
    if (!img || !img.width) return
    const ar = aspect ?? img.width / img.height
    const initial = centerCrop(
      makeAspectCrop({ unit: '%', width: 90 }, ar, img.width, img.height),
      img.width,
      img.height,
    )
    setCrop(initial)
    setCompletedCrop(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect])

  // showHandles を ON にした瞬間、初期クロップを与えるためもう一度 handleImgLoad
  // 相当の処理を走らせる（画像 load 済みで onLoad は再発火しないため）
  useEffect(() => {
    if (!showHandles) {
      setCrop(undefined)
      setCompletedCrop(null)
      return
    }
    const img = imgRef.current
    if (!img || !img.width) return
    if (hasApplied) {
      setCrop({ unit: '%', x: 0, y: 0, width: 100, height: 100 })
      return
    }
    const ar = aspect ?? img.width / img.height
    const initial = centerCrop(
      makeAspectCrop({ unit: '%', width: 90 }, ar, img.width, img.height),
      img.width,
      img.height,
    )
    setCrop(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHandles, hasApplied])

  const handleRotate = (delta: 90 | -90) => {
    setRotation((r) => (((r + delta) % 360) + 360) % 360)
    // 回転後はクロップが画像範囲外になりやすいのでリセット
    setCrop(undefined)
    setCompletedCrop(null)
  }

  // 現在の workingFile + crop + rotation から JPEG Blob を生成する共通処理。
  // downsize=false: サイズ制限なし（プレビュー用）、true: 長辺 1600px に縮小（確定用）
  const renderBlob = async (downsize: boolean): Promise<Blob | null> => {
    if (!imgRef.current) return null
    const img = imgRef.current
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    const scaleX = naturalW / img.width
    const scaleY = naturalH / img.height
    const cropPx = completedCrop ?? {
      x: 0,
      y: 0,
      width: img.width,
      height: img.height,
      unit: 'px' as const,
    }
    const cx = Math.round(cropPx.x * scaleX)
    const cy = Math.round(cropPx.y * scaleY)
    const cw = Math.round(cropPx.width * scaleX)
    const ch = Math.round(cropPx.height * scaleY)
    const isQuarterTurn = rotation === 90 || rotation === 270
    const finalW = isQuarterTurn ? ch : cw
    const finalH = isQuarterTurn ? cw : ch
    const MAX_LONG_EDGE = 1600
    const scale = downsize
      ? Math.min(1, MAX_LONG_EDGE / Math.max(finalW, finalH))
      : 1
    const outW = Math.max(1, Math.round(finalW * scale))
    const outH = Math.max(1, Math.round(finalH * scale))
    const preRotateW = isQuarterTurn ? outH : outW
    const preRotateH = isQuarterTurn ? outW : outH
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(workingFile, cx, cy, cw, ch, {
        resizeWidth: preRotateW,
        resizeHeight: preRotateH,
        resizeQuality: 'high',
      })
    } catch {
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
    if (!ctx) {
      bitmap.close?.()
      throw new Error('Canvas 2D が取得できません')
    }
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    ctx.drawImage(bitmap, -preRotateW / 2, -preRotateH / 2)
    bitmap.close?.()
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )
  }

  // 「トリミング」ボタン: 2 段階
  //   1 回目 (showHandles=false): ハンドル・比率 UI を表示するだけ
  //   2 回目 (showHandles=true, !hasApplied): 現在の枠を仮確定 → workingFile 差替
  const handleTrimButton = async () => {
    if (!showHandles) {
      setShowHandles(true)
      return
    }
    setBusy(true)
    try {
      const blob = await renderBlob(false)
      if (!blob) return
      const newFile = new File([blob], workingFile.name, { type: 'image/jpeg' })
      setWorkingFile(newFile)
      setRotation(0)
      // 新しい workingFile で画像が load されると handleImgLoad が
      // hasApplied=true を見て外枠いっぱいのクロップを設定する
      setHasApplied(true)
    } catch (err) {
      console.error('[PhotoEditModal] handleTrimButton failed', err)
    } finally {
      setBusy(false)
    }
  }

  // 「戻す」ボタン: 元の props.file に戻し、初期状態（ハンドル非表示）へ
  const handleUndoButton = () => {
    setWorkingFile(file)
    setRotation(0)
    setCrop(undefined)
    setCompletedCrop(null)
    setShowHandles(false)
    setHasApplied(false)
  }

  const handleConfirm = async () => {
    if (!imgRef.current) return
    setBusy(true)
    try {
      const blob = await renderBlob(true)
      if (!blob) throw new Error('画像のエンコードに失敗しました')
      onConfirm(blob, file.name, {
        takenAt: parseDateInputValue(takenAtStr),
        caption: caption.trim() ? caption.trim() : null,
        lat,
        lng,
        headingDeg,
      })
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : '画像処理に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  // 位置・方向の編集モードのとき: モーダル全体を地図ピッカーに差し替える。
  if (mode === 'location') {
    return (
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9999]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl h-[90vh] flex flex-col">
          <PhotoLocationPicker
            initialLat={lat}
            initialLng={lng}
            initialHeadingDeg={headingDeg}
            onCancel={() => setMode('photo')}
            onSave={(nlat, nlng, nheading) => {
              setLat(nlat)
              setLng(nlng)
              setHeadingDeg(nheading)
              setMode('photo')
            }}
          />
        </div>
      </div>
    )
  }

  return (
    // 親モーダル (CoordinatePhotoModal) は backdrop click で閉じる作りなので、
    // PhotoEditModal 内のクリックがそこまで伝播しないように stopPropagation。
    // これがないと「写真を 1 枚アップロード → 親モーダルが閉じてしまう」現象になる。
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9999]"
      onClick={(e) => e.stopPropagation()}
    >
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
            showHandles ? (
              <ReactCrop
                crop={crop}
                onChange={(c) => setCrop(c)}
                onComplete={(c) => setCompletedCrop(c)}
                aspect={hasApplied ? undefined : aspect}
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
            )
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          )}
        </div>

        {/* メタ情報入力: 撮影日・備考は 1 行ずつ横並び、位置・方向は「地図で編集」ボタンのみ */}
        <div className="px-4 py-2 border-t bg-slate-50 space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600 shrink-0 w-14">撮影日</label>
            <input
              type="date"
              value={takenAtStr}
              onChange={(e) => setTakenAtStr(e.target.value)}
              className="px-2 py-1 text-sm border rounded"
            />
            {enableLocationEdit && (
              <button
                type="button"
                onClick={() => setMode('location')}
                className="ml-auto text-xs px-2 py-1 border rounded text-blue-700 border-blue-300 hover:bg-blue-50 inline-flex items-center gap-1"
              >
                <MapPin className="h-3.5 w-3.5" />
                地図で編集
              </button>
            )}
            {!enableLocationEdit && !exifLoaded && (
              <span className="text-[10px] text-slate-400">EXIF 読み取り中…</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600 shrink-0 w-14">備考</label>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="任意のメモ（例: 杭頭飛び、コンクリート巻き 等）"
              className="flex-1 px-2 py-1 text-sm border rounded"
            />
          </div>
        </div>

        {/* トリミング比率選択（トリミングハンドル表示時のみ） */}
        {showHandles && (
          <div className="px-4 py-1.5 border-t bg-slate-50 flex items-center gap-1 text-xs flex-wrap">
            {/* 横長 / 縦長 の向きトグル。1:1・自由 のときは効かない */}
            <div className="inline-flex rounded border overflow-hidden mr-2">
              <button
                onClick={() => setOrientation('landscape')}
                disabled={aspectKey === '1:1' || aspectKey === 'free'}
                className={`px-2 py-0.5 border-r ${
                  orientation === 'landscape'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-100'
                } disabled:opacity-40`}
              >
                横長
              </button>
              <button
                onClick={() => setOrientation('portrait')}
                disabled={aspectKey === '1:1' || aspectKey === 'free'}
                className={`px-2 py-0.5 ${
                  orientation === 'portrait'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-100'
                } disabled:opacity-40`}
              >
                縦長
              </button>
            </div>
            {(['1:1', '2:3', '3:4', '9:16', 'free'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setAspectKey(k)}
                className={`px-2 py-0.5 rounded border ${
                  aspectKey === k
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {k === 'free' ? '自由' : k}
              </button>
            ))}
          </div>
        )}

        <div className="px-4 py-2 border-t flex items-center gap-2 flex-wrap">
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
          {!hasApplied && (
            <button
              onClick={handleTrimButton}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded text-blue-700 border-blue-300 hover:bg-blue-50 disabled:opacity-50"
              title={
                showHandles
                  ? '現在の枠でトリミングを実行'
                  : 'トリミング枠を表示して編集を開始'
              }
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              トリミング
            </button>
          )}
          {hasApplied && (
            <button
              onClick={handleUndoButton}
              disabled={busy}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              title="元の写真に戻す"
            >
              戻す
            </button>
          )}
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            確定
          </button>
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 写真の位置・方向ピッカー（PhotoEditModal の内部画面）
// ----------------------------------------------------------------------------

// 位置 + 方向のマーカーアイコン。中心の青円 + 矢印（heading 方向）。
function createLocationArrowIcon(headingDeg: number | null): L.DivIcon {
  const arrow =
    headingDeg == null
      ? ''
      : `<div style="
          position: absolute;
          top: 50%;
          left: 50%;
          width: 0;
          height: 0;
          transform: translate(-50%, -50%) rotate(${headingDeg}deg) translateY(-22px);
          border-left: 8px solid transparent;
          border-right: 8px solid transparent;
          border-bottom: 16px solid #1d4ed8;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
        "></div>`
  return L.divIcon({
    className: 'photo-loc-marker',
    html: `<div style="position: relative; width: 18px; height: 18px;">
      ${arrow}
      <div style="
        width: 18px;
        height: 18px;
        background: #1d4ed8;
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>
    </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

// 2点間の方位角（北=0, 東=90 ...）を 0..360 度で返す。
// 写真ピンと同じ向き付け（マーカーから見たタップ位置の方角）。
function bearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const φ1 = toRad(from.lat)
  const φ2 = toRad(to.lat)
  const Δλ = toRad(to.lng - from.lng)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  const θ = Math.atan2(y, x)
  return (toDeg(θ) + 360) % 360
}

// 地図シングルタップで:
//   位置が未設定 → タップ位置に新規ピンを落とす
//   位置がある  → ピンからタップ位置への方位角を heading に反映する
function MapTapHandler({
  origin,
  onPick,
  onSetHeading,
}: {
  origin: { lat: number; lng: number } | null
  onPick: (lat: number, lng: number) => void
  onSetHeading: (deg: number) => void
}) {
  useMapEvents({
    click(e) {
      if (!origin) {
        onPick(e.latlng.lat, e.latlng.lng)
        return
      }
      // マーカー自身に触れたシングルタップは Leaflet 側で marker click として
      // 処理されるため、ここに来るのは「マーカー外」のタップ。
      onSetHeading(bearingDeg(origin, { lat: e.latlng.lat, lng: e.latlng.lng }))
    },
  })
  return null
}

function PhotoLocationPicker({
  initialLat,
  initialLng,
  initialHeadingDeg,
  onCancel,
  onSave,
}: {
  initialLat: number | null
  initialLng: number | null
  initialHeadingDeg: number | null
  onCancel: () => void
  onSave: (lat: number | null, lng: number | null, headingDeg: number | null) => void
}) {
  const [lat, setLat] = useState<number | null>(initialLat)
  const [lng, setLng] = useState<number | null>(initialLng)
  const [headingDeg, setHeadingDeg] = useState<number | null>(initialHeadingDeg ?? 0)

  // 初期位置が無いときは日本の中心付近を仮表示（位置を取らないと地図が広がりすぎる）
  const initialCenter: [number, number] = initialLat != null && initialLng != null
    ? [initialLat, initialLng]
    : [35.681, 139.767]

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b flex items-center gap-2 bg-slate-50">
        <MapPin className="h-4 w-4 text-blue-600" />
        <h3 className="text-base font-semibold flex-1">
          {initialLat != null && initialLng != null
            ? '撮影方向を編集'
            : '撮影位置・方向を編集'}
        </h3>
        <button
          onClick={onCancel}
          className="p-1 text-slate-400 hover:text-slate-700 rounded"
          title="戻る"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-4 py-1.5 text-[11px] text-slate-600 border-b">
        {lat == null || lng == null
          ? '地図をタップして撮影位置を指定してください。'
          : 'ピンをドラッグして位置変更／ピンの外をタップして向きを指定します。'}
      </div>

      <div className="flex-1 min-h-0">
        <MapContainer
          center={initialCenter}
          zoom={initialLat != null ? 17 : 5}
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
        >
          <TileLayer
            url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
            attribution="出典: 国土地理院"
            maxNativeZoom={18}
            maxZoom={20}
          />
          <MapTapHandler
            origin={lat != null && lng != null ? { lat, lng } : null}
            onPick={(la, ln) => {
              setLat(la)
              setLng(ln)
            }}
            onSetHeading={(deg) => setHeadingDeg(deg)}
          />
          {lat != null && lng != null && (
            <Marker
              position={[lat, lng]}
              icon={createLocationArrowIcon(headingDeg)}
              draggable
              eventHandlers={{
                dragend(e) {
                  const m = e.target as L.Marker
                  const ll = m.getLatLng()
                  setLat(ll.lat)
                  setLng(ll.lng)
                },
              }}
            />
          )}
        </MapContainer>
      </div>

      <div className="px-4 py-2 border-t bg-slate-50 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <MapPin className="h-3.5 w-3.5" />
          {lat != null && lng != null ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : '未設定'}
        </div>
        <div className="flex items-center gap-2">
          <Compass className="h-3.5 w-3.5 text-slate-600" />
          {/* スライダーは -180 (左=反時計回り) 〜 +180 (右=時計回り) の符号付き表現。
              中央 0 が北。両端はどちらも 180°。実データは 0..360 に正規化して保持 */}
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={
              headingDeg == null
                ? 0
                : headingDeg > 180
                  ? headingDeg - 360
                  : headingDeg
            }
            onChange={(e) => {
              const raw = parseInt(e.target.value, 10)
              if (!Number.isFinite(raw)) return
              setHeadingDeg(((raw % 360) + 360) % 360)
            }}
            className="flex-1"
          />
          <input
            type="number"
            min={0}
            max={359}
            value={headingDeg ?? 0}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) setHeadingDeg(((v % 360) + 360) % 360)
            }}
            className="w-16 px-1.5 py-0.5 text-xs border rounded text-right"
          />
          <span className="text-xs text-slate-500">°</span>
        </div>
      </div>

      <div className="px-4 py-2 border-t flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          キャンセル
        </button>
        <button
          onClick={() => onSave(lat, lng, headingDeg)}
          disabled={lat == null || lng == null}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          確定
        </button>
      </div>
    </div>
  )
}
