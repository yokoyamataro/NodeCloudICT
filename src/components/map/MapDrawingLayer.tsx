// 地図上に手書きペイントを重ねるレイヤ (touch / stylus / mouse 対応)。
//
// 3 モード:
//   ・'off'    描画無効。既存ストロークだけ表示。マップ操作は通常通り。
//   ・'pen'    ドラッグでストロークを描く。地図の pan/zoom は無効化。
//   ・'eraser' ストロークをクリックで削除。
//
// 保存座標は lat/lng なので、地図を伸縮・移動しても地図上の位置は保持される。
//
// 実装メモ:
//   ・入力は Pointer Events (mouse / touch / pen 統一) を map.getContainer() に
//     直接 addEventListener で拾う。Leaflet の 'mousemove' はブラウザ実装差で
//     touchmove から発火しないケースがあり、モバイル実機で「線が残らない」
//     現象があった。Pointer Events + setPointerCapture でモバイル safari も含めて
//     取りこぼしを防ぐ。
//   ・pen モード中は Leaflet の dragging/zoom を全部 disable、container の
//     touchAction: none で iOS のスクロールも抑止する。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Polyline, useMap } from 'react-leaflet'
import type { LatLng } from 'leaflet'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  type MapDrawingStroke,
  type LineStyle,
} from '@/stores/mapDrawingStore'

export type DrawingMode = 'off' | 'pen' | 'eraser'

interface Props {
  farmId: string | null
  mode: DrawingMode
  color: string
  widthPx: number
  lineStyle: LineStyle
}

/** LineStyle → Leaflet Polyline の dashArray に変換 (太さに合わせて自動調整) */
function dashArrayFor(style: LineStyle, widthPx: number): string | undefined {
  if (style === 'solid') return undefined
  if (style === 'dashed') return `${widthPx * 3},${widthPx * 2}`
  // dotted: 点(円点) は lineCap=round と併せて短い dash で表現
  return `0.1,${widthPx * 1.8}`
}

export function MapDrawingLayer({
  farmId,
  mode,
  color,
  widthPx,
  lineStyle,
}: Props) {
  const map = useMap()
  const strokes = useMapDrawingStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_STROKES : EMPTY_STROKES,
  )
  const fetchByFarm = useMapDrawingStore((s) => s.fetchByFarm)
  const addStroke = useMapDrawingStore((s) => s.addStroke)
  const deleteStroke = useMapDrawingStore((s) => s.deleteStroke)

  // 描画中の 1 ストローク (プレビュー用)
  const [currentPositions, setCurrentPositions] = useState<[number, number][]>([])
  // ref も持つ: pointermove コールバックから setState 経由でも良いが、
  // event ハンドラを毎回 re-attach しないよう ref で共有する。
  const currentRef = useRef<LatLng[] | null>(null)

  // farm 切替時に fetch
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // 描画中は地図の pan/zoom を止める + カーソル + touchAction を制御
  useEffect(() => {
    const drawing = mode === 'pen'
    const container = map.getContainer()
    if (drawing) {
      map.dragging.disable()
      map.touchZoom.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.boxZoom.disable()
      container.style.cursor = 'crosshair'
      container.style.touchAction = 'none'
    } else {
      map.dragging.enable()
      map.touchZoom.enable()
      map.doubleClickZoom.enable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      container.style.cursor = mode === 'eraser' ? 'not-allowed' : ''
      container.style.touchAction = ''
    }
    return () => {
      container.style.cursor = ''
      container.style.touchAction = ''
    }
  }, [mode, map])

  // ペンモード時: pointer events を container に直接バインド
  useEffect(() => {
    if (mode !== 'pen') return
    const container = map.getContainer()

    const commit = () => {
      const pts = currentRef.current
      currentRef.current = null
      setCurrentPositions([])
      if (!pts || pts.length < 2 || !farmId) return
      const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      void addStroke({ farmId, color, widthPx, lineStyle, points: geo })
    }

    const eventToLatLng = (e: PointerEvent): LatLng | null => {
      try {
        // Leaflet の型定義は MouseEvent 前提だが、PointerEvent は MouseEvent の
        // 派生型なので実行時は問題無く動く。cast で通す。
        return map.mouseEventToLatLng(e as unknown as MouseEvent)
      } catch {
        return null
      }
    }

    const onDown = (e: PointerEvent) => {
      // 右クリック / 中クリックは無視 (button != 0)
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const latlng = eventToLatLng(e)
      if (!latlng) return
      currentRef.current = [latlng]
      setCurrentPositions([[latlng.lat, latlng.lng]])
      // 以降のイベントを container 外でも受け取る
      try {
        container.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      if (!currentRef.current) return
      const latlng = eventToLatLng(e)
      if (!latlng) return
      currentRef.current.push(latlng)
      // 頻繁な setState は重いので coalescing なしのシンプル実装
      setCurrentPositions(currentRef.current.map((p) => [p.lat, p.lng]))
      e.preventDefault()
    }
    const onUp = (e: PointerEvent) => {
      if (!currentRef.current) return
      commit()
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    const onCancel = () => {
      if (!currentRef.current) return
      // 進行中ストロークを保存 (leave/cancel でも失わないよう)
      commit()
    }

    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerup', onUp)
    container.addEventListener('pointercancel', onCancel)
    container.addEventListener('pointerleave', onCancel)
    return () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerup', onUp)
      container.removeEventListener('pointercancel', onCancel)
      container.removeEventListener('pointerleave', onCancel)
    }
  }, [mode, map, farmId, color, widthPx, lineStyle, addStroke])

  const strokesRendered = useMemo(
    () =>
      strokes.map((s: MapDrawingStroke) => (
        <Polyline
          key={s.id}
          positions={s.points.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: s.color,
            weight: s.width_px,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
            dashArray: dashArrayFor(
              (s.line_style ?? 'solid') as LineStyle,
              s.width_px,
            ),
          }}
          eventHandlers={
            mode === 'eraser'
              ? { click: () => void deleteStroke(s.id) }
              : undefined
          }
        />
      )),
    [strokes, mode, deleteStroke],
  )

  return (
    <>
      {strokesRendered}
      {currentPositions.length >= 2 && (
        <Polyline
          positions={currentPositions}
          pathOptions={{
            color,
            weight: widthPx,
            opacity: 0.7,
            lineCap: 'round',
            lineJoin: 'round',
            dashArray: dashArrayFor(lineStyle, widthPx),
          }}
        />
      )}
    </>
  )
}
