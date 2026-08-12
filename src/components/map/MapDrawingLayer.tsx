// 地図上に手書きペイント + 直線 + 円 + 円弧 + 面 + テキスト注釈を重ねるレイヤ。
//
// モード:
//   ・'off'     描画無効。既存アイテムだけ表示。マップ操作は通常通り。
//   ・'pen'     ドラッグでフリーハンドのストローク (地図の 1 本指 pan は無効化、2 本指ピンチは有効)。
//   ・'line'    ドラッグで始点/終点だけ記録し 2 点の直線。
//   ・'circle'  2 タップで中心 → 縁 (半径 = 2 点間距離、L.Circle で描画)。
//   ・'arc'     3 タップで始点 → 通過点 → 終点 (3 点を通る一意の円弧を近似ポリラインで描画)。
//   ・'polygon' タップで頂点を追加。最初の頂点を再タップ or 「面を閉じる」で確定。半透明で塗り潰し。
//   ・'text'    タップした点にテキスト注釈 (prompt 経由)。
//   ・'select'  ストロークをタップで選択 → 青ハンドルをドラッグで頂点移動 / 長押しで削除 /
//               辺の中点の「+」タップで頂点追加 (直線・円・円弧は追加/削除不可、位置移動のみ)。
//   ・'eraser'  アイテムをクリックで削除。
//
// 保存座標は lat/lng なので、地図を伸縮・移動しても地図上の位置は保持される。

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle as LeafletCircle,
  Marker,
  Pane,
  Polygon as LeafletPolygon,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L, { type LatLng } from 'leaflet'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  type MapDrawingStroke,
  type LineStyle,
} from '@/stores/mapDrawingStore'

export type DrawingMode =
  | 'off'
  | 'pen'
  | 'line'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'text'
  | 'select'
  | 'eraser'

interface Props {
  farmId: string | null
  mode: DrawingMode
  color: string
  widthPx: number
  lineStyle: LineStyle
}

/** kind ごとの最小頂点数 (これ以下には削除できない) */
const MIN_POINTS: Record<string, number> = {
  stroke: 2,
  polygon: 3,
  line: 2,
  circle: 2,
  arc: 3,
}

/** 頂点追加 (中点 +) が許される kind (直線・円・円弧は頂点数固定) */
const VARIABLE_VERTEX_KINDS = new Set<string>(['stroke', 'polygon'])

/** ハンドル: 頂点移動用 (青丸 + 白フチ) */
const HANDLE_ICON = L.divIcon({
  className: 'map-drawing-handle',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

/** ハンドル: 頂点追加用 (緑丸 + "+") */
const MIDPOINT_ICON = L.divIcon({
  className: 'map-drawing-midpoint',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#22c55e;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);color:white;font-size:10px;font-weight:bold;line-height:10px;text-align:center;">+</div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})

/** ポリゴン描画中の最初の頂点マーカー (再タップで閉じる目印, 橙色) */
const FIRST_VERTEX_ICON = L.divIcon({
  className: 'map-drawing-first-vertex',
  html: '<div style="width:20px;height:20px;border-radius:50%;background:#f97316;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.6);"></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})

/** LineStyle → Leaflet Polyline の dashArray に変換 (太さに合わせて自動調整) */
export function dashArrayFor(style: LineStyle, widthPx: number): string | undefined {
  if (style === 'solid') return undefined
  if (style === 'dashed') return `${widthPx * 3},${widthPx * 2}`
  return `0.1,${widthPx * 1.8}`
}

/** width_px (1-20) → テキストの font-size px。1→10px, 5→18px, 10→28px 相当 */
function textFontSizePx(widthPx: number): number {
  return Math.max(10, 8 + widthPx * 2)
}

/** テキスト注釈用の divIcon (背景なし、測点ラベルと同じ「白フチ + 色本体」スタイル) */
export function makeTextIcon(text: string, color: string, widthPx: number, interactive: boolean): L.DivIcon {
  const size = textFontSizePx(widthPx)
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
    iconSize: undefined as unknown as L.PointExpression,
    iconAnchor: [0, size / 2],
  })
}

/** 2 点の緯度経度から中点を求める (簡易平均、短距離なら十分な精度) */
function midpointOfLatLngs(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): { lat: number; lng: number } {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
}

/**
 * 3 点 (始点・通過点・終点) を通る円弧を計算し、近似ポリライン用の頂点列を返す。
 * 局所平面近似 (原点 = 始点) で外接円中心 + 半径を求め、角度をスイープしながら
 * segments 個に分割する。1km 程度までなら投影歪みは無視できる。
 */
export function arcThroughPoints(
  start: { lat: number; lng: number },
  mid: { lat: number; lng: number },
  end: { lat: number; lng: number },
  segments = 40,
): Array<[number, number]> {
  const originLat = start.lat
  const originLng = start.lng
  const metersPerDegLat = 110540
  const metersPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180)
  const toXY = (p: { lat: number; lng: number }) => ({
    x: (p.lng - originLng) * metersPerDegLng,
    y: (p.lat - originLat) * metersPerDegLat,
  })
  const toLatLng = (xy: { x: number; y: number }): [number, number] => [
    originLat + xy.y / metersPerDegLat,
    originLng + xy.x / metersPerDegLng,
  ]

  const p0 = toXY(start)
  const p1 = toXY(mid)
  const p2 = toXY(end)

  // 外接円の中心 (perpendicular bisector 交点)
  const ax = p0.x
  const ay = p0.y
  const bx = p1.x
  const by = p1.y
  const cx = p2.x
  const cy = p2.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-6) {
    // ほぼ共線 → 折れ線として返す
    return [
      [start.lat, start.lng],
      [mid.lat, mid.lng],
      [end.lat, end.lng],
    ]
  }
  const centerX =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d
  const centerY =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d
  const radius = Math.hypot(ax - centerX, ay - centerY)

  // 3 点の角度
  const a0 = Math.atan2(ay - centerY, ax - centerX)
  const a1 = Math.atan2(by - centerY, bx - centerX)
  const a2 = Math.atan2(cy - centerY, cx - centerX)

  // a0 を基準に反時計回りに正規化した相対角度
  const twoPi = Math.PI * 2
  const norm = (a: number) => ((a - a0) % twoPi + twoPi) % twoPi
  const na1 = norm(a1)
  const na2 = norm(a2)

  // 通過点 (na1) が終点 (na2) より手前なら反時計回り、そうでなければ時計回り
  const ccw = na1 < na2
  const sweep = ccw ? na2 : twoPi - na2

  const result: Array<[number, number]> = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const angle = a0 + (ccw ? 1 : -1) * sweep * t
    const x = centerX + radius * Math.cos(angle)
    const y = centerY + radius * Math.sin(angle)
    result.push(toLatLng({ x, y }))
  }
  return result
}

/** 円の半径 (メートル) を center/edge の 2 点から求める */
export function circleRadiusMeters(
  center: { lat: number; lng: number },
  edge: { lat: number; lng: number },
): number {
  return L.latLng(center.lat, center.lng).distanceTo(L.latLng(edge.lat, edge.lng))
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
  const updateStrokePoints = useMapDrawingStore((s) => s.updateStrokePoints)

  const [currentPositions, setCurrentPositions] = useState<[number, number][]>([])
  const currentRef = useRef<LatLng[] | null>(null)

  // タップ式の描画で進行中の頂点列 (circle: 中心のみ / arc: [start] or [start,mid] / polygon: [p1..])
  const [shapeProgress, setShapeProgress] = useState<{
    kind: 'circle' | 'arc' | 'polygon'
    points: Array<{ lat: number; lng: number }>
  } | null>(null)

  // 選択モードの状態
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{
    strokeId: string
    points: Array<{ lat: number; lng: number }>
  } | null>(null)

  // テキスト追加ダイアログ (window.prompt を使わずページ内モーダルで入力させる。
  // ブラウザで「追加のダイアログを表示しない」がチェックされている状況でも動くように)
  const [textDialog, setTextDialog] = useState<{
    lat: number
    lng: number
    value: string
  } | null>(null)
  const textDialogInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (textDialog) {
      // 開いた瞬間にフォーカス
      requestAnimationFrame(() => textDialogInputRef.current?.focus())
    }
  }, [textDialog])

  // farm 切替時に fetch + 状態リセット
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
    setShapeProgress(null)
    setSelectedId(null)
    setDragPreview(null)
  }, [farmId, fetchByFarm])

  // モード変更時にモードに合わない状態をクリア
  useEffect(() => {
    if (mode !== 'circle' && mode !== 'arc' && mode !== 'polygon') {
      setShapeProgress(null)
    }
    if (mode !== 'text') setTextDialog(null)
    if (mode !== 'select') {
      setSelectedId(null)
      setDragPreview(null)
    }
  }, [mode])

  // 描画中は地図の 1 本指 pan を止める。text/circle/arc/polygon は click ベースだが誤 pan 防止で
  // dragging は残す (単発 click を邪魔しないため)。pen/line だけ dragging を止める。
  useEffect(() => {
    const isPointerDraw = mode === 'pen' || mode === 'line'
    const isTapDraw = mode === 'text' || mode === 'circle' || mode === 'arc' || mode === 'polygon'
    const container = map.getContainer()
    if (isPointerDraw) {
      map.dragging.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.boxZoom.disable()
      map.touchZoom.enable()
      container.style.cursor = 'crosshair'
      container.style.touchAction = 'pinch-zoom'
    } else if (isTapDraw) {
      map.dragging.enable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      map.touchZoom.enable()
      container.style.cursor =
        mode === 'text' ? 'text' : 'crosshair'
      container.style.touchAction = ''
    } else {
      map.dragging.enable()
      map.touchZoom.enable()
      map.doubleClickZoom.enable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      container.style.cursor =
        mode === 'eraser' ? 'not-allowed' : mode === 'select' ? 'pointer' : ''
      container.style.touchAction = ''
    }
    return () => {
      container.style.cursor = ''
      container.style.touchAction = ''
    }
  }, [mode, map])

  // タップ式描画 + text 追加: useMapEvents
  useMapEvents({
    click: (e) => {
      if (!farmId) return
      if (mode === 'text') {
        setTextDialog({ lat: e.latlng.lat, lng: e.latlng.lng, value: '' })
        return
      }
      if (mode === 'circle') {
        if (!shapeProgress || shapeProgress.kind !== 'circle') {
          setShapeProgress({ kind: 'circle', points: [{ lat: e.latlng.lat, lng: e.latlng.lng }] })
        } else {
          const points = [...shapeProgress.points, { lat: e.latlng.lat, lng: e.latlng.lng }]
          void addStroke({
            farmId,
            kind: 'circle',
            color,
            widthPx,
            lineStyle,
            points,
          })
          setShapeProgress(null)
        }
        return
      }
      if (mode === 'arc') {
        if (!shapeProgress || shapeProgress.kind !== 'arc') {
          setShapeProgress({ kind: 'arc', points: [{ lat: e.latlng.lat, lng: e.latlng.lng }] })
        } else if (shapeProgress.points.length === 1) {
          setShapeProgress({
            kind: 'arc',
            points: [...shapeProgress.points, { lat: e.latlng.lat, lng: e.latlng.lng }],
          })
        } else {
          const points = [...shapeProgress.points, { lat: e.latlng.lat, lng: e.latlng.lng }]
          void addStroke({
            farmId,
            kind: 'arc',
            color,
            widthPx,
            lineStyle,
            points,
          })
          setShapeProgress(null)
        }
        return
      }
      if (mode === 'polygon') {
        const current = shapeProgress?.kind === 'polygon' ? shapeProgress.points : []
        // 頂点が 3 個以上ある状態で最初の頂点付近をタップ → 閉じる
        if (current.length >= 3) {
          const first = current[0]
          const firstPx = map.latLngToContainerPoint([first.lat, first.lng])
          const clickPx = map.latLngToContainerPoint(e.latlng)
          if (firstPx.distanceTo(clickPx) < 22) {
            void addStroke({
              farmId,
              kind: 'polygon',
              color,
              widthPx,
              lineStyle,
              points: current,
            })
            setShapeProgress(null)
            return
          }
        }
        const nextPoints = [...current, { lat: e.latlng.lat, lng: e.latlng.lng }]
        setShapeProgress({ kind: 'polygon', points: nextPoints })
        return
      }
    },
  })

  // Escape で進行中の描画をキャンセル
  useEffect(() => {
    if (!shapeProgress) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShapeProgress(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shapeProgress])

  // pen / line モード: pointer events (フリーハンド / 2 点直線)
  useEffect(() => {
    if (mode !== 'pen' && mode !== 'line') return
    const container = map.getContainer()

    const activePointers = new Set<number>()
    let drawingPointerId: number | null = null

    const commit = () => {
      const pts = currentRef.current
      currentRef.current = null
      setCurrentPositions([])
      if (!pts || pts.length < 2 || !farmId) return
      const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: geo })
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
      if (mode === 'line') {
        const start = currentRef.current[0]
        currentRef.current = [start, latlng]
        setCurrentPositions([
          [start.lat, start.lng],
          [latlng.lat, latlng.lng],
        ])
      } else {
        currentRef.current.push(latlng)
        setCurrentPositions(currentRef.current.map((p) => [p.lat, p.lng]))
      }
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

  // ポリゴン描画中に「面を閉じる」ボタンを L.Control として map の右上に表示
  useEffect(() => {
    if (!shapeProgress || shapeProgress.kind !== 'polygon' || shapeProgress.points.length < 3) {
      return
    }
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control')
    container.style.cssText =
      'background:white;padding:6px 12px;font-size:12px;font-weight:bold;cursor:pointer;color:#111;border:2px solid rgba(0,0,0,0.2);border-radius:4px;'
    container.innerText = '✓ 面を閉じる'
    L.DomEvent.on(container, 'click', (ev) => {
      L.DomEvent.stop(ev)
      if (!farmId) return
      void addStroke({
        farmId,
        kind: 'polygon',
        color,
        widthPx,
        lineStyle,
        points: shapeProgress.points,
      })
      setShapeProgress(null)
    })
    L.DomEvent.disableClickPropagation(container)
    const control = new L.Control({ position: 'topright' })
    control.onAdd = () => container
    control.addTo(map)
    return () => {
      control.remove()
    }
  }, [shapeProgress, map, farmId, color, widthPx, lineStyle, addStroke])

  // 選択中のストローク (端点ハンドル用)
  const selectedStroke = useMemo(
    () =>
      mode === 'select' && selectedId
        ? items.find((s) => s.id === selectedId) ?? null
        : null,
    [items, mode, selectedId],
  )
  // 頂点ハンドル用の points (ドラッグ中はプレビュー)
  const handlePoints =
    selectedStroke && selectedStroke.kind !== 'text'
      ? dragPreview?.strokeId === selectedStroke.id
        ? dragPreview.points
        : selectedStroke.points
      : null

  // 既存アイテムの描画
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
              icon={makeTextIcon(s.text ?? '', s.color, s.width_px, isEraser)}
              interactive={isEraser}
              eventHandlers={
                isEraser ? { click: () => void deleteStroke(s.id) } : undefined
              }
            />
          )
        }

        // ドラッグ中は preview の points を採用してリアルタイム反映
        const pointsForRender =
          dragPreview?.strokeId === s.id ? dragPreview.points : s.points
        const isSelected = mode === 'select' && s.id === selectedId
        const dash = dashArrayFor(
          (s.line_style ?? 'solid') as LineStyle,
          s.width_px,
        )
        const clickHandlers =
          mode === 'eraser'
            ? { click: () => void deleteStroke(s.id) }
            : mode === 'select'
              ? { click: () => setSelectedId(s.id) }
              : undefined

        if (s.kind === 'circle') {
          const center = pointsForRender[0]
          const edge = pointsForRender[1]
          if (!center || !edge) return null
          const radius = circleRadiusMeters(center, edge)
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <LeafletCircle
                  center={[center.lat, center.lng]}
                  radius={radius}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    fill: false,
                  }}
                  interactive={false}
                />
              )}
              <LeafletCircle
                center={[center.lat, center.lng]}
                radius={radius}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  fill: false,
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        if (s.kind === 'arc') {
          if (pointsForRender.length < 3) return null
          const [a, b, c] = pointsForRender
          const arcPts = arcThroughPoints(a, b, c)
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <Polyline
                  positions={arcPts}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                  interactive={false}
                />
              )}
              <Polyline
                positions={arcPts}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  lineCap: 'round',
                  lineJoin: 'round',
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        if (s.kind === 'polygon') {
          const positions = pointsForRender.map(
            (p) => [p.lat, p.lng] as [number, number],
          )
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <LeafletPolygon
                  positions={positions}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    fill: false,
                  }}
                  interactive={false}
                />
              )}
              <LeafletPolygon
                positions={positions}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  fillColor: s.color,
                  fillOpacity: 0.2,
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        // stroke (フリーハンド or 直線)
        const positions = pointsForRender.map(
          (p) => [p.lat, p.lng] as [number, number],
        )
        return (
          <Fragment key={s.id}>
            {isSelected && (
              <Polyline
                positions={positions}
                pathOptions={{
                  color: '#3b82f6',
                  weight: s.width_px + 8,
                  opacity: 0.35,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
                interactive={false}
              />
            )}
            <Polyline
              positions={positions}
              pathOptions={{
                color: s.color,
                weight: s.width_px,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
                dashArray: dash,
              }}
              eventHandlers={clickHandlers}
            />
          </Fragment>
        )
      }),
    [items, mode, deleteStroke, selectedId, dragPreview],
  )

  // タップ式描画の進行中プレビュー
  const shapePreview = useMemo(() => {
    if (!shapeProgress) return null
    if (shapeProgress.kind === 'circle') {
      const center = shapeProgress.points[0]
      if (!center) return null
      return (
        <Marker
          position={[center.lat, center.lng]}
          icon={FIRST_VERTEX_ICON}
          interactive={false}
        />
      )
    }
    if (shapeProgress.kind === 'arc') {
      return (
        <>
          {shapeProgress.points.map((p, i) => (
            <Marker
              key={`arc-progress-${i}`}
              position={[p.lat, p.lng]}
              icon={FIRST_VERTEX_ICON}
              interactive={false}
            />
          ))}
          {shapeProgress.points.length === 2 && (
            <Polyline
              positions={shapeProgress.points.map(
                (p) => [p.lat, p.lng] as [number, number],
              )}
              pathOptions={{
                color,
                weight: widthPx,
                opacity: 0.5,
                dashArray: '4,4',
              }}
            />
          )}
        </>
      )
    }
    // polygon
    const positions = shapeProgress.points.map(
      (p) => [p.lat, p.lng] as [number, number],
    )
    return (
      <>
        {positions.length >= 2 && (
          <Polyline
            positions={positions}
            pathOptions={{
              color,
              weight: widthPx,
              opacity: 0.6,
              dashArray: '4,4',
            }}
          />
        )}
        {shapeProgress.points.map((p, i) => (
          <Marker
            key={`poly-progress-${i}`}
            position={[p.lat, p.lng]}
            icon={i === 0 ? FIRST_VERTEX_ICON : HANDLE_ICON}
            interactive={false}
          />
        ))}
      </>
    )
  }, [shapeProgress, color, widthPx])

  // 選択中ストロークの中点 (+) ハンドル用の位置列。頂点数可変 kind でのみ表示。
  const midpoints = useMemo(() => {
    if (!selectedStroke || !handlePoints) return []
    if (!VARIABLE_VERTEX_KINDS.has(selectedStroke.kind)) return []
    const list: Array<{ index: number; lat: number; lng: number }> = []
    const closed = selectedStroke.kind === 'polygon'
    for (let i = 0; i < handlePoints.length - 1; i++) {
      const m = midpointOfLatLngs(handlePoints[i], handlePoints[i + 1])
      list.push({ index: i, lat: m.lat, lng: m.lng })
    }
    if (closed && handlePoints.length >= 3) {
      const m = midpointOfLatLngs(
        handlePoints[handlePoints.length - 1],
        handlePoints[0],
      )
      list.push({ index: handlePoints.length - 1, lat: m.lat, lng: m.lng })
    }
    return list
  }, [selectedStroke, handlePoints])

  return (
    <Pane name="map-drawing" style={{ zIndex: 500 }}>
      {rendered}
      {shapePreview}
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
      {/* 選択中ストロークの頂点ハンドル (ドラッグで移動 / 長押しで削除) */}
      {selectedStroke &&
        handlePoints &&
        handlePoints.map((p, idx) => (
          <Marker
            key={`vertex-${selectedStroke.id}-${idx}`}
            position={[p.lat, p.lng]}
            icon={HANDLE_ICON}
            draggable
            eventHandlers={{
              drag: (e) => {
                const marker = e.target as L.Marker
                const latlng = marker.getLatLng()
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? { lat: latlng.lat, lng: latlng.lng } : pp,
                )
                setDragPreview({
                  strokeId: selectedStroke.id,
                  points: nextPoints,
                })
              },
              dragend: (e) => {
                const marker = e.target as L.Marker
                const latlng = marker.getLatLng()
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? { lat: latlng.lat, lng: latlng.lng } : pp,
                )
                setDragPreview(null)
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
              contextmenu: () => {
                // 長押し or 右クリックで頂点削除 (頂点数可変 kind のみ)
                if (!VARIABLE_VERTEX_KINDS.has(selectedStroke.kind)) return
                const min = MIN_POINTS[selectedStroke.kind] ?? 2
                if (selectedStroke.points.length <= min) return
                const nextPoints = selectedStroke.points.filter(
                  (_, i) => i !== idx,
                )
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
            }}
          />
        ))}
      {/* 中点 + ハンドル (頂点数可変 kind: stroke / polygon のみ) */}
      {selectedStroke &&
        midpoints.map((m) => (
          <Marker
            key={`midpoint-${selectedStroke.id}-${m.index}`}
            position={[m.lat, m.lng]}
            icon={MIDPOINT_ICON}
            eventHandlers={{
              click: () => {
                const nextPoints = [...selectedStroke.points]
                nextPoints.splice(m.index + 1, 0, { lat: m.lat, lng: m.lng })
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
            }}
          />
        ))}
      {/* テキスト入力ダイアログ (window.prompt の代替。Portal で map の外に出す) */}
      {textDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/40 p-4"
            onClick={() => setTextDialog(null)}
          >
            <div
              className="bg-white rounded-lg shadow-xl p-4 w-full max-w-sm flex flex-col gap-3"
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="text-sm font-semibold text-slate-800">
                テキストを入力
              </div>
              <input
                ref={textDialogInputRef}
                type="text"
                value={textDialog.value}
                onChange={(ev) =>
                  setTextDialog({ ...textDialog, value: ev.target.value })
                }
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    const trimmed = textDialog.value.trim()
                    if (trimmed && farmId) {
                      void addText({
                        farmId,
                        color,
                        widthPx,
                        lat: textDialog.lat,
                        lng: textDialog.lng,
                        text: trimmed,
                      })
                    }
                    setTextDialog(null)
                  } else if (ev.key === 'Escape') {
                    setTextDialog(null)
                  }
                }}
                placeholder="ここに文字を入力"
                className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTextDialog(null)}
                  className="px-3 py-1.5 text-sm rounded border text-slate-700 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = textDialog.value.trim()
                    if (trimmed && farmId) {
                      void addText({
                        farmId,
                        color,
                        widthPx,
                        lat: textDialog.lat,
                        lng: textDialog.lng,
                        text: trimmed,
                      })
                    }
                    setTextDialog(null)
                  }}
                  disabled={!textDialog.value.trim()}
                  className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  追加
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Pane>
  )
}
