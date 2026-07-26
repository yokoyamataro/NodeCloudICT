// 地図上に手書きペイントを重ねるレイヤ。
//
// 3 モード:
//   ・'off'    描画無効。既存ストロークだけ表示。マップ操作は通常通り。
//   ・'pen'    ドラッグでストロークを描く。地図の pan/zoom は無効化。
//   ・'eraser' ストロークをクリックで削除。
//
// 保存座標は lat/lng なので、地図を伸縮・移動しても地図上の位置は保持される。

import { useEffect, useMemo, useState } from 'react'
import { Polyline, useMap, useMapEvents } from 'react-leaflet'
import type { LatLng, LeafletMouseEvent } from 'leaflet'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  type MapDrawingStroke,
} from '@/stores/mapDrawingStore'

export type DrawingMode = 'off' | 'pen' | 'eraser'

interface Props {
  farmId: string | null
  mode: DrawingMode
  color: string
  widthPx: number
}

export function MapDrawingLayer({ farmId, mode, color, widthPx }: Props) {
  const map = useMap()
  const strokes = useMapDrawingStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_STROKES : EMPTY_STROKES,
  )
  const fetchByFarm = useMapDrawingStore((s) => s.fetchByFarm)
  const addStroke = useMapDrawingStore((s) => s.addStroke)
  const deleteStroke = useMapDrawingStore((s) => s.deleteStroke)

  const [currentPoints, setCurrentPoints] = useState<LatLng[] | null>(null)

  // farm 切替時に fetch
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // 描画中は地図の pan/zoom (drag / touchDrag / scrollWheelZoom / doubleClickZoom) を止める
  useEffect(() => {
    const drawing = mode === 'pen'
    if (drawing) {
      map.dragging.disable()
      map.touchZoom.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.boxZoom.disable()
      // 地図コンテナのカーソルを crosshair に
      map.getContainer().style.cursor = 'crosshair'
    } else {
      map.dragging.enable()
      map.touchZoom.enable()
      map.doubleClickZoom.enable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      if (mode === 'eraser') {
        map.getContainer().style.cursor = 'not-allowed'
      } else {
        map.getContainer().style.cursor = ''
      }
    }
    return () => {
      map.getContainer().style.cursor = ''
    }
  }, [mode, map])

  // ペンモード時のマップイベント: mousedown → mousemove → mouseup で 1 ストローク
  useMapEvents(
    mode === 'pen'
      ? {
          mousedown: (e: LeafletMouseEvent) => {
            setCurrentPoints([e.latlng])
          },
          mousemove: (e: LeafletMouseEvent) => {
            setCurrentPoints((prev) => (prev == null ? null : [...prev, e.latlng]))
          },
          mouseup: () => {
            const pts = currentPoints
            setCurrentPoints(null)
            if (!pts || pts.length < 2 || !farmId) return
            const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
            void addStroke({ farmId, color, widthPx, points: geo })
          },
          // 画面外に出た時にストロークを確定
          mouseout: () => {
            const pts = currentPoints
            if (!pts || pts.length < 2 || !farmId) {
              setCurrentPoints(null)
              return
            }
            setCurrentPoints(null)
            const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
            void addStroke({ farmId, color, widthPx, points: geo })
          },
        }
      : {},
  )

  const currentPositions = useMemo<[number, number][]>(
    () => (currentPoints ? currentPoints.map((p) => [p.lat, p.lng]) : []),
    [currentPoints],
  )

  return (
    <>
      {strokes.map((s: MapDrawingStroke) => (
        <Polyline
          key={s.id}
          positions={s.points.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: s.color,
            weight: s.width_px,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
          }}
          eventHandlers={
            mode === 'eraser'
              ? { click: () => void deleteStroke(s.id) }
              : undefined
          }
        />
      ))}
      {currentPositions.length >= 2 && (
        <Polyline
          positions={currentPositions}
          pathOptions={{
            color,
            weight: widthPx,
            opacity: 0.7,
            lineCap: 'round',
            lineJoin: 'round',
            dashArray: '4,4',
          }}
        />
      )}
    </>
  )
}
