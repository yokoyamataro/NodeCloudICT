// 地図上に手書きペイント + テキスト注釈を重ねるレイヤ (touch / mouse 対応)。
//
// 4 モード:
//   ・'off'    描画無効。既存アイテムだけ表示。マップ操作は通常通り。
//   ・'pen'    ドラッグでストロークを描く。地図の pan/zoom (touchZoom は除く) は無効化。
//   ・'text'   タップした点にテキスト注釈を追加 (prompt 経由)。
//   ・'eraser' アイテムをクリックで削除。
//
// 保存座標は lat/lng なので、地図を伸縮・移動しても地図上の位置は保持される。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Marker, Pane, Polyline, useMap, useMapEvents } from 'react-leaflet'
import L, { type LatLng } from 'leaflet'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  type MapDrawingStroke,
  type LineStyle,
} from '@/stores/mapDrawingStore'

export type DrawingMode = 'off' | 'pen' | 'text' | 'eraser'

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
  return `0.1,${widthPx * 1.8}`
}

/** width_px (1-20) → テキストの font-size px。1→10px, 5→18px, 10→28px 相当 */
function textFontSizePx(widthPx: number): number {
  return Math.max(10, 8 + widthPx * 2)
}

/** テキスト注釈用の divIcon (背景なし、測点ラベルと同じ「白フチ + 色本体」スタイル) */
function makeTextIcon(text: string, color: string, widthPx: number, interactive: boolean): L.DivIcon {
  const size = textFontSizePx(widthPx)
  // 白フチは text-shadow を 8 方向に敷いて表現 (測点ラベルと同じ)
  const shadow =
    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff'
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const html = `<span style="color:${color};font-size:${size}px;font-weight:bold;text-shadow:${shadow};white-space:nowrap;pointer-events:${
    interactive ? 'auto' : 'none'
  };cursor:${interactive ? 'pointer' : 'default'};">${escaped}</span>`
  return L.divIcon({
    className: 'map-drawing-text-label',
    html,
    // 起点はテキストの左中央 (measurement label と同じ配置)
    iconSize: undefined as unknown as L.PointExpression,
    iconAnchor: [0, size / 2],
  })
}

export function MapDrawingLayer({
  farmId,
  mode,
  color,
  widthPx,
  lineStyle,
}: Props) {
  const map = useMap()
  const items = useMapDrawingStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_STROKES : EMPTY_STROKES,
  )
  const fetchByFarm = useMapDrawingStore((s) => s.fetchByFarm)
  const addStroke = useMapDrawingStore((s) => s.addStroke)
  const addText = useMapDrawingStore((s) => s.addText)
  const deleteStroke = useMapDrawingStore((s) => s.deleteStroke)

  const [currentPositions, setCurrentPositions] = useState<[number, number][]>([])
  const currentRef = useRef<LatLng[] | null>(null)

  // farm 切替時に fetch
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // 描画中は地図の 1 本指 pan を止める。text モードでも同じ (単発 click だが誤 pan 防止)
  useEffect(() => {
    const drawing = mode === 'pen' || mode === 'text'
    const container = map.getContainer()
    if (drawing) {
      // pen だけ dragging を止める。text は click だけなので普通に pan させても OK
      // だが誤操作防止で pen 同様に止める。
      if (mode === 'pen') map.dragging.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.boxZoom.disable()
      map.touchZoom.enable()
      container.style.cursor = mode === 'pen' ? 'crosshair' : 'text'
      container.style.touchAction = 'pinch-zoom'
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

  // text モード: 単発 click でテキスト追加
  useMapEvents(
    mode === 'text'
      ? {
          click: (e) => {
            if (!farmId) return
            const input = prompt('テキストを入力', '')
            if (input == null) return
            const trimmed = input.trim()
            if (!trimmed) return
            void addText({
              farmId,
              color,
              widthPx,
              lat: e.latlng.lat,
              lng: e.latlng.lng,
              text: trimmed,
            })
          },
        }
      : {},
  )

  // pen モード: pointer events
  useEffect(() => {
    if (mode !== 'pen') return
    const container = map.getContainer()

    const activePointers = new Set<number>()
    let drawingPointerId: number | null = null

    const commit = () => {
      const pts = currentRef.current
      currentRef.current = null
      setCurrentPositions([])
      if (!pts || pts.length < 2 || !farmId) return
      const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      void addStroke({ farmId, color, widthPx, lineStyle, points: geo })
    }
    const abortDrawing = () => {
      currentRef.current = null
      setCurrentPositions([])
      drawingPointerId = null
    }
    const eventToLatLng = (e: PointerEvent): LatLng | null => {
      try {
        return map.mouseEventToLatLng(e as unknown as MouseEvent)
      } catch {
        return null
      }
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      activePointers.add(e.pointerId)
      if (activePointers.size > 1) {
        if (drawingPointerId != null) {
          try {
            container.releasePointerCapture(drawingPointerId)
          } catch {
            /* ignore */
          }
        }
        abortDrawing()
        return
      }
      const latlng = eventToLatLng(e)
      if (!latlng) return
      drawingPointerId = e.pointerId
      currentRef.current = [latlng]
      setCurrentPositions([[latlng.lat, latlng.lng]])
      try {
        container.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      if (drawingPointerId == null || e.pointerId !== drawingPointerId) return
      if (activePointers.size > 1) return
      if (!currentRef.current) return
      const latlng = eventToLatLng(e)
      if (!latlng) return
      currentRef.current.push(latlng)
      setCurrentPositions(currentRef.current.map((p) => [p.lat, p.lng]))
      e.preventDefault()
    }
    const onUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (e.pointerId !== drawingPointerId) return
      drawingPointerId = null
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      commit()
    }
    const onCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (e.pointerId !== drawingPointerId) return
      drawingPointerId = null
      commit()
    }

    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerup', onUp)
    container.addEventListener('pointercancel', onCancel)
    return () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerup', onUp)
      container.removeEventListener('pointercancel', onCancel)
    }
  }, [mode, map, farmId, color, widthPx, lineStyle, addStroke])

  const rendered = useMemo(
    () =>
      items.map((s: MapDrawingStroke) => {
        if (s.kind === 'text') {
          const pt = s.points[0]
          if (!pt) return null
          const isEraser = mode === 'eraser'
          return (
            <Marker
              key={s.id}
              position={[pt.lat, pt.lng]}
              icon={makeTextIcon(
                s.text ?? '',
                s.color,
                s.width_px,
                isEraser,
              )}
              interactive={isEraser}
              eventHandlers={
                isEraser ? { click: () => void deleteStroke(s.id) } : undefined
              }
            />
          )
        }
        // stroke
        return (
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
        )
      }),
    [items, mode, deleteStroke],
  )

  return (
    <Pane name="map-drawing" style={{ zIndex: 500 }}>
      {rendered}
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
    </Pane>
  )
}
