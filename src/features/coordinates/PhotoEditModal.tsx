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
}: PhotoEditModalProps) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [rotation, setRotation] = useState(0) // 度数（90 単位）
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null)
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  // 撮影日: EXIF DateTimeOriginal を優先、なければアップロード日（今）。両方ユーザ編集可能。
  const [takenAtStr, setTakenAtStr] = useState<string>(() => toDateInputValue(new Date()))
  const [caption, setCaption] = useState<string>('')
  const [exifLoaded, setExifLoaded] = useState(false)
  // 位置・方向
  const [lat, setLat] = useState<number | null>(initialLat)
  const [lng, setLng] = useState<number | null>(initialLng)
  const [headingDeg, setHeadingDeg] = useState<number | null>(initialHeadingDeg)
  const [mode, setMode] = useState<'photo' | 'location'>('photo')

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // ファイルから EXIF (撮影日 + GPS 位置 + 撮影方向) を非同期で読み、取れたら反映。
  // GPS / 方向は EXIF が最優先（写真ファイル自身が持つ「撮影時」の情報なので、
  // デバイス現在値より信頼できる）。
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

        {/* メタ情報入力（撮影日 + 備考）。EXIF があれば撮影日にプリフィル済み。 */}
        <div className="px-4 py-2 border-t bg-slate-50 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1.5 items-center">
          <label className="text-xs text-slate-600">撮影日</label>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={takenAtStr}
              onChange={(e) => setTakenAtStr(e.target.value)}
              className="px-2 py-1 text-sm border rounded"
            />
            <span className="text-[10px] text-slate-400">
              {exifLoaded ? '（EXIF が無い場合は本日）' : 'EXIF 読み取り中…'}
            </span>
          </div>
          <label className="text-xs text-slate-600">備考</label>
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="任意のメモ（例: 杭頭飛び、コンクリート巻き 等）"
            className="px-2 py-1 text-sm border rounded"
          />
          {enableLocationEdit && (
            <>
              <label className="text-xs text-slate-600">位置・方向</label>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-600 inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {lat != null && lng != null
                    ? `${lat.toFixed(6)}, ${lng.toFixed(6)}`
                    : '未設定'}
                </span>
                <span className="text-xs text-slate-600 inline-flex items-center gap-1">
                  <Compass className="h-3.5 w-3.5" />
                  {headingDeg != null ? `${headingDeg.toFixed(0)}°` : '未設定'}
                </span>
                <button
                  type="button"
                  onClick={() => setMode('location')}
                  className="ml-auto text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  地図で編集
                </button>
              </div>
            </>
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
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={headingDeg ?? 0}
            onChange={(e) => setHeadingDeg(parseInt(e.target.value, 10))}
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
