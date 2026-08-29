// 「この範囲を保存」ボタン。地図の上に置く。
//
// 走った場所の自動キャッシュでは「これから初めて行く場所」を埋められない。
// 地図を目的の場所に動かしてこれを押すだけで、その範囲を事前に用意できる。
// 範囲を囲ませたり名前を付けさせたりはしない (ドライバーに管理させない方針)。

import { useState } from 'react'
import { useMap } from 'react-leaflet'
import { Download, Loader2, X } from 'lucide-react'
import { downloadRange, estimate, type TileRange } from '@/lib/tileDownload'

/** 保存するズームの範囲。CachedTileLayer と揃える */
const MIN_Z = 12
const MAX_Z = 15

interface Props {
  /** タイル URL テンプレート */
  url: string
  /** キャッシュのキーに使う識別子 (背景の種類ごとに分ける) */
  layerId: string
  /** 保存が終わったら呼ぶ (容量表示の更新用) */
  onDone?: () => void
}

export function SaveViewButton({ url, layerId, onDone }: Props) {
  const map = useMap()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const stopRef = { current: false }

  const currentRange = (): TileRange => {
    const b = map.getBounds()
    return {
      minLat: b.getSouth(),
      maxLat: b.getNorth(),
      minLon: b.getWest(),
      maxLon: b.getEast(),
      minZoom: MIN_Z,
      maxZoom: MAX_Z,
    }
  }

  const handleClick = async () => {
    if (busy) {
      stopRef.current = true
      return
    }
    const range = currentRange()
    const est = await estimate(range)
    const mb = est.bytes / 1024 / 1024
    if (est.exceedsCap) {
      setMessage(
        `範囲が大きすぎます (約 ${mb.toFixed(0)}MB)。\n地図を拡大して範囲を狭めてください。`,
      )
      return
    }
    if (
      !confirm(
        `表示中の範囲の地図を保存します。\n\nタイル ${est.count} 枚 / 約 ${mb.toFixed(1)}MB\n\n通信量がかかります。よろしいですか?`,
      )
    ) {
      return
    }
    setBusy(true)
    setMessage(null)
    setProgress({ done: 0, total: est.count })
    stopRef.current = false
    try {
      const res = await downloadRange(
        url,
        layerId,
        range,
        (done, total) => setProgress({ done, total }),
        () => stopRef.current,
      )
      setMessage(
        stopRef.current
          ? '保存を中止しました'
          : `保存しました (新規 ${res.saved} 枚${res.skipped > 0 ? ` / 既存 ${res.skipped} 枚` : ''}${res.failed > 0 ? ` / 失敗 ${res.failed} 枚` : ''})`,
      )
      onDone?.()
    } finally {
      setBusy(false)
      setProgress(null)
      window.setTimeout(() => setMessage(null), 5000)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow border border-slate-600 bg-slate-900/90 text-[11px] text-slate-100"
        title="表示している範囲の地図を保存して、圏外でも見られるようにする"
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress ? `保存中 ${progress.done}/${progress.total}` : '保存中'}
            <X className="h-3.5 w-3.5 ml-1 opacity-70" />
          </>
        ) : (
          <>
            <Download className="h-3.5 w-3.5" />
            この範囲を保存
          </>
        )}
      </button>
      {message && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[1000] max-w-[80%] px-3 py-1.5 rounded shadow bg-slate-900/90 text-[11px] text-slate-100 whitespace-pre-wrap text-center">
          {message}
        </div>
      )}
    </>
  )
}
