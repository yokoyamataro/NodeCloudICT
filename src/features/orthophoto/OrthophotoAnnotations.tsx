// オルソ画像ページの作図・計測レイヤ。CoordinateMap の MapContainer の子として描画する。
// 親側が tool / fontSize / lastMeasure / pending comment 等の状態を保持し、
// 当コンポーネントは地図クリックの受付・図形描画を担当する。
import { useEffect, useRef, useState } from 'react'
import { Polyline, Polygon, Marker, CircleMarker, Circle, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import type { CoordinateConverter } from '@/lib/coordinates'
import {
  type Annotation,
  type AnnotationKind,
  newAnnotationId,
} from '@/lib/annotations'

export type ToolMode =
  | 'none'
  | 'point'
  | 'point-coord' // クリックを座標管理に新規登録
  | AnnotationKind
  | 'measure-dist'
  | 'measure-area'
  | 'measure-perp'
  | 'erase'

export interface MeasureGeom {
  kind: 'dist' | 'area' | 'perp'
  vertices: [number, number][]
  value: number // m or m²
}

interface Props {
  tool: ToolMode
  color: string
  fontSize: number
  /** 作図時に付与するレイヤ名 */
  currentLayer: string
  annotations: Annotation[]
  setAnnotations: (next: Annotation[]) => void
  converter: CoordinateConverter
  lastMeasure: MeasureGeom | null
  setLastMeasure: (m: MeasureGeom | null) => void
  /** 点(座標登録) ツールで呼び出される */
  onAddCoordinate?: (lat: number, lng: number) => void
  /** コメント道具で呼び出される（モーダル入力用） */
  onRequestComment?: (pos: [number, number]) => void
  /** 選択ツール時、図形クリックで親に通知（インスペクタ表示用） */
  onSelect?: (id: string) => void
  /** ピック（スナップ）モード: 近接する点・端部に吸着 */
  snapEnabled?: boolean
  /** 図形以外のスナップ候補（座標管理の点・区域の頂点など） */
  extraSnapPoints?: [number, number][]
}

// ---- アイコン生成 ----
const dotIcon = (color: string) =>
  L.divIcon({
    className: 'anno-point',
    html: `<div style="background:${color};width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })

const textIcon = (text: string, color: string, size: number) =>
  L.divIcon({
    className: 'anno-text',
    html: `<div style="
      writing-mode:horizontal-tb;text-orientation:mixed;
      color:${color};font-weight:700;font-size:${size}px;
      text-shadow:-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff,1px 1px 0 #fff;
      white-space:nowrap;transform:translate(-50%,-50%)
    ">${escapeHtml(text)}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

// コメント: 横書き固定、改行・行送りは normal、@メンションは色付け
const commentIcon = (text: string, color: string, size: number) => {
  const html = escapeHtml(text).replace(/(@[\w぀-ヿ一-鿿._-]+)/g, '<span style="color:#2563eb;font-weight:600">$1</span>')
  return L.divIcon({
    className: 'anno-comment',
    html: `<div style="display:flex;flex-direction:column;align-items:flex-start;transform:translate(8px,-100%);writing-mode:horizontal-tb;text-orientation:mixed">
      <div style="background:#fff;border:1.5px solid ${color};border-radius:6px;padding:3px 7px;
                   font-size:${size}px;line-height:1.4;color:#1f2937;max-width:280px;
                   box-shadow:0 1px 3px rgba(0,0,0,.25);
                   white-space:pre-wrap;word-break:break-word;writing-mode:horizontal-tb">${html}</div>
      <div style="width:10px;height:10px;background:${color};border:1.5px solid #fff;border-radius:50%;
                   margin-top:-4px;margin-left:-2px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

const dimLabelIcon = (label: string, color: string, size: number) =>
  L.divIcon({
    className: 'anno-dim-label',
    html: `<div style="
      writing-mode:horizontal-tb;
      background:rgba(255,255,255,.9);border:1px solid ${color};color:${color};
      font-size:${size}px;font-weight:700;padding:1px 4px;border-radius:3px;
      white-space:nowrap;transform:translate(-50%,-50%);box-shadow:0 1px 2px rgba(0,0,0,.2)
    ">${escapeHtml(label)}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---- 計測ヘルパ（平面 X=北/Y=東） ----
function planeDist(c: CoordinateConverter, a: [number, number], b: [number, number]): number {
  const A = c.toXY(a[0], a[1])
  const B = c.toXY(b[0], b[1])
  return Math.hypot(B.x - A.x, B.y - A.y)
}
function planeArea(c: CoordinateConverter, verts: [number, number][]): number {
  if (verts.length < 3) return 0
  const pts = verts.map((v) => c.toXY(v[0], v[1]))
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}
function perpDist(c: CoordinateConverter, a: [number, number], b: [number, number], p: [number, number]): number {
  const A = c.toXY(a[0], a[1])
  const B = c.toXY(b[0], b[1])
  const P = c.toXY(p[0], p[1])
  const dN = B.x - A.x
  const dE = B.y - A.y
  const L = Math.hypot(dN, dE)
  if (L === 0) return 0
  return Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / L
}

// 中点（lat/lng 平均で十分な精度・短距離）
function midLatLng(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
// 重心
function centroidLatLng(verts: [number, number][]): [number, number] {
  let s0 = 0, s1 = 0
  for (const v of verts) { s0 += v[0]; s1 += v[1] }
  return [s0 / verts.length, s1 / verts.length]
}
// P から線AB に下ろした垂線の足
function perpFoot(c: CoordinateConverter, a: [number, number], b: [number, number], p: [number, number]): [number, number] {
  const A = c.toXY(a[0], a[1])
  const B = c.toXY(b[0], b[1])
  const P = c.toXY(p[0], p[1])
  const ABx = B.x - A.x, ABy = B.y - A.y
  const L2 = ABx * ABx + ABy * ABy
  if (L2 === 0) return a
  const t = ((P.x - A.x) * ABx + (P.y - A.y) * ABy) / L2
  const Fx = A.x + t * ABx
  const Fy = A.y + t * ABy
  const ll = c.toLatLng(Fx, Fy)
  return [ll.lat, ll.lng]
}

function fmtLen(v: number): string {
  if (v < 1) return `${(v * 100).toFixed(1)} cm`
  return `${v.toFixed(3)} m`
}
function fmtArea(v: number): string {
  return `${v.toFixed(2)} m² (${(v / 10000).toFixed(4)} ha)`
}

export function OrthophotoAnnotations({
  tool,
  color,
  fontSize,
  currentLayer,
  annotations,
  setAnnotations,
  converter,
  lastMeasure,
  setLastMeasure,
  onAddCoordinate,
  onRequestComment,
  onSelect,
  snapEnabled = false,
  extraSnapPoints,
}: Props) {
  const [tempVerts, setTempVerts] = useState<[number, number][]>([])
  // マウス追従プレビュー位置（ラバーバンド用）
  const [hoverPos, setHoverPos] = useState<[number, number] | null>(null)
  const lastToolRef = useRef<ToolMode>(tool)
  useEffect(() => {
    if (lastToolRef.current !== tool) {
      lastToolRef.current = tool
      setTempVerts([])
      setHoverPos(null)
    }
  }, [tool])

  const map = useMap()

  const finalizeLine = () => {
    if (tempVerts.length >= 2) {
      setAnnotations([
        ...annotations,
        { id: newAnnotationId(), kind: 'line', vertices: tempVerts, color, layer: currentLayer },
      ])
    }
    setTempVerts([])
  }
  const finalizePolygon = () => {
    if (tempVerts.length >= 3) {
      setAnnotations([
        ...annotations,
        { id: newAnnotationId(), kind: 'polygon', vertices: tempVerts, color, layer: currentLayer },
      ])
    }
    setTempVerts([])
  }
  const finalizeMeasureArea = () => {
    if (tempVerts.length >= 3) {
      const a = planeArea(converter, tempVerts)
      setLastMeasure({ kind: 'area', vertices: tempVerts, value: a })
    }
    setTempVerts([])
  }

  // 既存図形からスナップ候補（端部・頂点・中心）を収集
  const annotationSnapPoints = (): [number, number][] => {
    const out: [number, number][] = []
    for (const a of annotations) {
      if (a.kind === 'point' || a.kind === 'text' || a.kind === 'comment') out.push(a.pos)
      else if (a.kind === 'line' || a.kind === 'polygon' || a.kind === 'dimension') {
        for (const v of a.vertices) out.push(v)
      } else if (a.kind === 'circle' || a.kind === 'arc') out.push(a.center)
    }
    return out
  }
  // クリック位置から最も近い候補（スクリーン上 12px 以内）を返す
  const findSnap = (e: L.LeafletMouseEvent): [number, number] | null => {
    const candidates: [number, number][] = [
      ...annotationSnapPoints(),
      ...(extraSnapPoints ?? []),
      ...tempVerts,
    ]
    if (candidates.length === 0) return null
    const cp = map.latLngToLayerPoint(e.latlng)
    let best: { d: number; ll: [number, number] } | null = null
    for (const c of candidates) {
      const p = map.latLngToLayerPoint(L.latLng(c[0], c[1]))
      const d = Math.hypot(p.x - cp.x, p.y - cp.y)
      if (d <= 12 && (!best || d < best.d)) best = { d, ll: c }
    }
    return best ? best.ll : null
  }

  useMapEvents({
    click(e) {
      const raw: [number, number] = [e.latlng.lat, e.latlng.lng]
      // ピック(スナップ)が ON で、作図/計測ツール中なら近接点に吸着
      const isPlacing = tool !== 'none' && tool !== 'erase'
      const snapped = snapEnabled && isPlacing ? findSnap(e) : null
      const ll: [number, number] = snapped ?? raw
      switch (tool) {
        case 'point':
          setAnnotations([
            ...annotations,
            { id: newAnnotationId(), kind: 'point', pos: ll, color, layer: currentLayer },
          ])
          break
        case 'point-coord':
          onAddCoordinate?.(ll[0], ll[1])
          break
        case 'line':
        case 'polygon':
        case 'measure-area':
          setTempVerts((v) => [...v, ll])
          break
        case 'circle': {
          const next = [...tempVerts, ll]
          if (next.length >= 2) {
            const c = converter.toXY(next[0][0], next[0][1])
            const p = converter.toXY(next[1][0], next[1][1])
            const r = Math.hypot(p.x - c.x, p.y - c.y)
            if (r > 0) {
              setAnnotations([
                ...annotations,
                { id: newAnnotationId(), kind: 'circle', center: next[0], radius: r, color, layer: currentLayer },
              ])
            }
            setTempVerts([])
          } else {
            setTempVerts(next)
          }
          break
        }
        case 'arc': {
          const next = [...tempVerts, ll]
          if (next.length >= 3) {
            const c = converter.toXY(next[0][0], next[0][1])
            const p1 = converter.toXY(next[1][0], next[1][1])
            const p2 = converter.toXY(next[2][0], next[2][1])
            const r = Math.hypot(p1.x - c.x, p1.y - c.y)
            let startDeg = (Math.atan2(p1.x - c.x, p1.y - c.y) * 180) / Math.PI
            let endDeg = (Math.atan2(p2.x - c.x, p2.y - c.y) * 180) / Math.PI
            startDeg = ((startDeg % 360) + 360) % 360
            endDeg = ((endDeg % 360) + 360) % 360
            // CCW での掃引角度（0..360）
            let sweep = (((endDeg - startDeg) % 360) + 360) % 360
            // 反対側にならないよう、常に短い側（minor arc）を採用
            if (sweep > 180) {
              const t = startDeg
              startDeg = endDeg
              endDeg = t
              sweep = 360 - sweep
            }
            if (endDeg <= startDeg) endDeg += 360
            void sweep
            if (r > 0) {
              setAnnotations([
                ...annotations,
                { id: newAnnotationId(), kind: 'arc', center: next[0], radius: r, startDeg, endDeg, color, layer: currentLayer },
              ])
            }
            setTempVerts([])
          } else {
            setTempVerts(next)
          }
          break
        }
        case 'measure-dist': {
          const next = [...tempVerts, ll]
          if (next.length >= 2) {
            const d = planeDist(converter, next[0], next[1])
            setLastMeasure({ kind: 'dist', vertices: next, value: d })
            setTempVerts([])
          } else {
            setTempVerts(next)
          }
          break
        }
        case 'measure-perp': {
          const next = [...tempVerts, ll]
          if (next.length >= 3) {
            const d = perpDist(converter, next[0], next[1], next[2])
            setLastMeasure({ kind: 'perp', vertices: next, value: d })
            setTempVerts([])
          } else {
            setTempVerts(next)
          }
          break
        }
        case 'text': {
          const text = window.prompt('表示する文字列', '')
          if (text && text.trim()) {
            setAnnotations([
              ...annotations,
              { id: newAnnotationId(), kind: 'text', pos: ll, text: text.trim(), color, size: fontSize, layer: currentLayer },
            ])
          }
          break
        }
        case 'comment':
          onRequestComment?.(ll)
          break
        default:
          break
      }
    },
    mousemove(e) {
      // 作図・計測モードのときだけ追従プレビュー位置を更新
      const placing = tool !== 'none' && tool !== 'erase'
      if (!placing) {
        if (hoverPos !== null) setHoverPos(null)
        return
      }
      let ll: [number, number] = [e.latlng.lat, e.latlng.lng]
      if (snapEnabled) {
        const snap = findSnap(e)
        if (snap) ll = snap
      }
      setHoverPos(ll)
    },
    mouseout() {
      setHoverPos(null)
    },
    dblclick() {
      if (tool === 'line') finalizeLine()
      else if (tool === 'polygon') finalizePolygon()
      else if (tool === 'measure-area') finalizeMeasureArea()
    },
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTempVerts([])
      else if (e.key === 'Enter') {
        if (tool === 'line') finalizeLine()
        else if (tool === 'polygon') finalizePolygon()
        else if (tool === 'measure-area') finalizeMeasureArea()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, tempVerts, annotations, color])

  useEffect(() => {
    if (tool === 'line' || tool === 'polygon' || tool === 'measure-area') {
      map.doubleClickZoom.disable()
    } else {
      map.doubleClickZoom.enable()
    }
  }, [map, tool])

  // 作図・計測モードのときはクロスヘアカーソルにして位置を選びやすくする
  // （選択／削除モードは標準のままにして既存の操作感を維持）
  useEffect(() => {
    const el = map.getContainer()
    const drawingTools: ToolMode[] = [
      'point',
      'point-coord',
      'line',
      'polygon',
      'circle',
      'arc',
      'text',
      'comment',
      'measure-dist',
      'measure-area',
      'measure-perp',
    ]
    if (drawingTools.includes(tool)) {
      el.style.cursor = 'crosshair'
    } else {
      el.style.cursor = ''
    }
    return () => {
      el.style.cursor = ''
    }
  }, [map, tool])

  const handleDelete = (id: string) => {
    if (tool !== 'erase') return
    if (!confirm('この図形を削除しますか？')) return
    setAnnotations(annotations.filter((a) => a.id !== id))
  }
  // 図形クリック時の挙動（選択ツール→インスペクタ、削除ツール→削除、その他→無視）
  const deletableProps = (id: string) => {
    if (tool === 'erase') return { eventHandlers: { click: () => handleDelete(id) } }
    if (tool === 'none' && onSelect) {
      return {
        eventHandlers: {
          click: (e: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(e)
            onSelect(id)
          },
        },
      }
    }
    return {}
  }

  // 計測結果ジオメトリの描画
  const renderLastMeasure = () => {
    if (!lastMeasure) return null
    const c = '#0ea5e9'
    if (lastMeasure.kind === 'dist' && lastMeasure.vertices.length >= 2) {
      const [a, b] = lastMeasure.vertices
      return (
        <>
          <Polyline positions={[a, b]} pathOptions={{ color: c, weight: 2, dashArray: '6,4' }} />
          <Marker position={midLatLng(a, b)} icon={dimLabelIcon(fmtLen(lastMeasure.value), c, fontSize)} interactive={false} />
        </>
      )
    }
    if (lastMeasure.kind === 'area' && lastMeasure.vertices.length >= 3) {
      return (
        <>
          <Polygon positions={lastMeasure.vertices} pathOptions={{ color: c, fillColor: c, fillOpacity: 0.1, weight: 2, dashArray: '6,4' }} />
          <Marker position={centroidLatLng(lastMeasure.vertices)} icon={dimLabelIcon(fmtArea(lastMeasure.value), c, fontSize)} interactive={false} />
        </>
      )
    }
    if (lastMeasure.kind === 'perp' && lastMeasure.vertices.length >= 3) {
      const [a, b, p] = lastMeasure.vertices
      const f = perpFoot(converter, a, b, p)
      return (
        <>
          <Polyline positions={[a, b]} pathOptions={{ color: c, weight: 2, dashArray: '6,4' }} />
          <Polyline positions={[p, f]} pathOptions={{ color: c, weight: 2 }} />
          <Marker position={midLatLng(p, f)} icon={dimLabelIcon(fmtLen(lastMeasure.value), c, fontSize)} interactive={false} />
        </>
      )
    }
    return null
  }

  // 寸法線アノテーションの描画（複数要素を配列で返す）
  const renderDimension = (a: Annotation & { kind: 'dimension' }): React.ReactNode => {
    const sz = a.size ?? fontSize
    if (a.subKind === 'dist' && a.vertices.length >= 2) {
      const [p1, p2] = a.vertices
      return [
        <Polyline key={`${a.id}-l`} positions={[p1, p2]} pathOptions={{ color: a.color, weight: 2 }} {...deletableProps(a.id)} />,
        <Marker key={`${a.id}-m`} position={midLatLng(p1, p2)} icon={dimLabelIcon(fmtLen(a.value), a.color, sz)} {...deletableProps(a.id)} />,
      ]
    }
    if (a.subKind === 'area' && a.vertices.length >= 3) {
      return [
        <Polygon key={`${a.id}-p`} positions={a.vertices} pathOptions={{ color: a.color, fillColor: a.color, fillOpacity: 0.08, weight: 2 }} {...deletableProps(a.id)} />,
        <Marker key={`${a.id}-m`} position={centroidLatLng(a.vertices)} icon={dimLabelIcon(fmtArea(a.value), a.color, sz)} {...deletableProps(a.id)} />,
      ]
    }
    if (a.subKind === 'perp' && a.vertices.length >= 3) {
      const [p1, p2, pp] = a.vertices
      const f = perpFoot(converter, p1, p2, pp)
      return [
        <Polyline key={`${a.id}-l1`} positions={[p1, p2]} pathOptions={{ color: a.color, weight: 2 }} {...deletableProps(a.id)} />,
        <Polyline key={`${a.id}-l2`} positions={[pp, f]} pathOptions={{ color: a.color, weight: 2 }} {...deletableProps(a.id)} />,
        <Marker key={`${a.id}-m`} position={midLatLng(pp, f)} icon={dimLabelIcon(fmtLen(a.value), a.color, sz)} {...deletableProps(a.id)} />,
      ]
    }
    return null
  }

  return (
    <>
      {annotations.map((a) => {
        if (a.kind === 'point') {
          return <Marker key={a.id} position={a.pos} icon={dotIcon(a.color)} {...deletableProps(a.id)} />
        }
        if (a.kind === 'line') {
          return (
            <Polyline key={a.id} positions={a.vertices} pathOptions={{ color: a.color, weight: 3, opacity: 0.9 }} {...deletableProps(a.id)} />
          )
        }
        if (a.kind === 'polygon') {
          return (
            <Polygon key={a.id} positions={a.vertices} pathOptions={{ color: a.color, fillColor: a.color, fillOpacity: 0.2, weight: 2 }} {...deletableProps(a.id)} />
          )
        }
        if (a.kind === 'circle') {
          return (
            <Circle key={a.id} center={a.center} radius={a.radius} pathOptions={{ color: a.color, fillColor: a.color, fillOpacity: 0.1, weight: 2 }} {...deletableProps(a.id)} />
          )
        }
        if (a.kind === 'arc') {
          const sweep = a.endDeg - a.startDeg
          const n = Math.max(8, Math.ceil(sweep / 2))
          const c = converter.toXY(a.center[0], a.center[1])
          const pts: [number, number][] = []
          for (let i = 0; i <= n; i++) {
            const deg = a.startDeg + (sweep * i) / n
            const rad = (deg * Math.PI) / 180
            const xy = { x: c.x + a.radius * Math.sin(rad), y: c.y + a.radius * Math.cos(rad) }
            const ll = converter.toLatLng(xy.x, xy.y)
            pts.push([ll.lat, ll.lng])
          }
          return (
            <Polyline key={a.id} positions={pts} pathOptions={{ color: a.color, weight: 2, opacity: 0.9 }} {...deletableProps(a.id)} />
          )
        }
        if (a.kind === 'text') {
          return <Marker key={a.id} position={a.pos} icon={textIcon(a.text, a.color, a.size ?? fontSize)} {...deletableProps(a.id)} />
        }
        if (a.kind === 'comment') {
          return <Marker key={a.id} position={a.pos} icon={commentIcon(a.text, a.color, a.size ?? fontSize)} {...deletableProps(a.id)} />
        }
        if (a.kind === 'dimension') return renderDimension(a)
        return null
      })}

      {/* 作図中（途中）の表示 ＋ マウス追従プレビュー */}
      {(() => {
        const placing = tool !== 'none' && tool !== 'erase'
        const hover = placing && hoverPos
        // 線/面/計測の折れ線プレビュー: 既存の tempVerts + マウス位置
        const previewVerts: [number, number][] =
          hover && tempVerts.length >= 1 &&
          (tool === 'line' || tool === 'polygon' || tool === 'measure-area' || tool === 'measure-dist' || tool === 'measure-perp')
            ? [...tempVerts, hoverPos]
            : tempVerts
        return (
          <>
            {previewVerts.length >= 2 && (
              <Polyline positions={previewVerts} pathOptions={{ color, weight: 2, dashArray: '4,3' }} />
            )}
            {/* 面: マウスから始点に戻る閉合プレビュー */}
            {tool === 'polygon' && hover && tempVerts.length >= 2 && (
              <Polyline positions={[hoverPos, tempVerts[0]]} pathOptions={{ color, weight: 1, dashArray: '2,3', opacity: 0.6 }} />
            )}
            {/* 円: 中心が決まっていればマウス位置までの半径で仮の円 */}
            {tool === 'circle' && hover && tempVerts.length === 1 && (() => {
              const cc = converter.toXY(tempVerts[0][0], tempVerts[0][1])
              const hh = converter.toXY(hoverPos[0], hoverPos[1])
              const r = Math.hypot(hh.x - cc.x, hh.y - cc.y)
              return (
                <>
                  <Circle center={tempVerts[0]} radius={r} pathOptions={{ color, weight: 1, dashArray: '4,3', fillOpacity: 0.05 }} />
                  <Polyline positions={[tempVerts[0], hoverPos]} pathOptions={{ color, weight: 1, dashArray: '2,3', opacity: 0.6 }} />
                </>
              )
            })()}
            {/* 円弧: 中心→マウスの仮半径線 */}
            {tool === 'arc' && hover && tempVerts.length >= 1 && (
              <Polyline positions={[tempVerts[0], hoverPos]} pathOptions={{ color, weight: 1, dashArray: '2,3', opacity: 0.6 }} />
            )}
            {/* 確定済みの頂点 */}
            {tempVerts.map((v, i) => (
              <CircleMarker
                key={`tv-${i}`}
                center={v}
                radius={4}
                pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 1 }}
              />
            ))}
            {/* マウス追従の小マーカー（スナップ時は強調） */}
            {hover && (
              <CircleMarker
                center={hoverPos}
                radius={snapEnabled ? 5 : 3}
                pathOptions={{ color, fillColor: '#fff', fillOpacity: 0.8, weight: 1.5 }}
              />
            )}
          </>
        )
      })()}

      {/* 最新の計測結果ジオメトリ（クリアまたは寸法保存まで残す） */}
      {renderLastMeasure()}
    </>
  )
}

// 計測値の表示用フォーマット（親で使う）
export function formatMeasureValue(m: MeasureGeom): string {
  if (m.kind === 'area') return fmtArea(m.value)
  return fmtLen(m.value)
}

// ツール一覧（作図／計測）
export const DRAW_TOOLS: { tool: ToolMode; label: string; help?: string }[] = [
  { tool: 'none', label: '選択' },
  { tool: 'point', label: '点' },
  { tool: 'point-coord', label: '点(座標登録)', help: 'クリック位置を座標管理に追加' },
  { tool: 'line', label: '線', help: 'クリックで頂点 / ダブルクリックで終了' },
  { tool: 'polygon', label: '面', help: 'クリックで頂点 / ダブルクリックで閉じる' },
  { tool: 'circle', label: '円', help: '中心 → 半径点' },
  { tool: 'arc', label: '円弧', help: '中心 → 始点 → 終点（CCW）' },
  { tool: 'text', label: '文字', help: 'クリックで文字列を配置' },
  { tool: 'comment', label: 'コメント', help: 'クリックで吹き出しコメントを配置（@メンション可）' },
  { tool: 'erase', label: '削除', help: '図形クリックで削除' },
]

export const MEASURE_TOOLS: { tool: ToolMode; label: string; help?: string }[] = [
  { tool: 'measure-dist', label: '距離', help: '2点クリック' },
  { tool: 'measure-area', label: '面積', help: 'クリックで頂点 / ダブルクリックで閉じる' },
  { tool: 'measure-perp', label: '垂線', help: '線の2点→対象1点の順にクリック' },
]
