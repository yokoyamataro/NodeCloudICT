// オルソ画像ページの作図・計測レイヤ。CoordinateMap の MapContainer の子として描画する。
// 担当: 道具モードに応じた地図クリックの受付、作図中図形の表示、保存済み図形の描画、計測の表示。
import { useEffect, useRef, useState } from 'react'
import { Polyline, Polygon, Marker, CircleMarker, Circle, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import type { CoordinateConverter } from '@/lib/coordinates'
import {
  type Annotation,
  type AnnotationKind,
  newAnnotationId,
} from '@/lib/annotations'

export type ToolMode = 'none' | AnnotationKind | 'measure-dist' | 'measure-area' | 'measure-perp' | 'erase'

export interface MeasureResult {
  kind: 'dist' | 'area' | 'perp'
  value: number // メートル / 平方メートル
  detail?: string // 補足表示
}

interface Props {
  tool: ToolMode
  color: string
  annotations: Annotation[]
  setAnnotations: (next: Annotation[]) => void
  converter: CoordinateConverter
  measureResult: MeasureResult | null
  setMeasureResult: (r: MeasureResult | null) => void
}

// ---- アイコン生成 ----
const dotIcon = (color: string) =>
  L.divIcon({
    className: 'anno-point',
    html: `<div style="background:${color};width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })

const textIcon = (text: string, color: string) =>
  L.divIcon({
    className: 'anno-text',
    html: `<div style="color:${color};font-weight:700;font-size:13px;text-shadow:-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff,1px 1px 0 #fff;white-space:nowrap;transform:translate(-50%,-50%)">${escapeHtml(text)}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

const commentIcon = (text: string, color: string) =>
  L.divIcon({
    className: 'anno-comment',
    html: `<div style="display:flex;flex-direction:column;align-items:flex-start;transform:translate(8px,-100%)">
      <div style="background:#fff;border:1.5px solid ${color};border-radius:6px;padding:2px 6px;font-size:11px;line-height:1.3;color:#1f2937;max-width:220px;box-shadow:0 1px 3px rgba(0,0,0,.25);white-space:pre-wrap">${escapeHtml(text)}</div>
      <div style="width:10px;height:10px;background:${color};border:1.5px solid #fff;border-radius:50%;margin-top:-4px;margin-left:-2px;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>
    </div>`,
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
  // 2D の外積の絶対値 / 線長
  return Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / L
}

export function OrthophotoAnnotations({
  tool,
  color,
  annotations,
  setAnnotations,
  converter,
  measureResult,
  setMeasureResult,
}: Props) {
  // 作図中の頂点（線・面・計測の途中状態）
  const [tempVerts, setTempVerts] = useState<[number, number][]>([])
  // tool が変わったら途中状態をリセット
  const lastToolRef = useRef<ToolMode>(tool)
  useEffect(() => {
    if (lastToolRef.current !== tool) {
      lastToolRef.current = tool
      setTempVerts([])
    }
  }, [tool])

  const map = useMap()

  const finalizeLine = () => {
    if (tempVerts.length >= 2) {
      setAnnotations([
        ...annotations,
        { id: newAnnotationId(), kind: 'line', vertices: tempVerts, color },
      ])
    }
    setTempVerts([])
  }
  const finalizePolygon = () => {
    if (tempVerts.length >= 3) {
      setAnnotations([
        ...annotations,
        { id: newAnnotationId(), kind: 'polygon', vertices: tempVerts, color },
      ])
    }
    setTempVerts([])
  }
  const finalizeMeasureArea = () => {
    if (tempVerts.length >= 3) {
      const a = planeArea(converter, tempVerts)
      setMeasureResult({
        kind: 'area',
        value: a,
        detail: `${tempVerts.length} 点`,
      })
    }
    setTempVerts([])
  }

  useMapEvents({
    click(e) {
      const ll: [number, number] = [e.latlng.lat, e.latlng.lng]
      switch (tool) {
        case 'point':
          setAnnotations([
            ...annotations,
            { id: newAnnotationId(), kind: 'point', pos: ll, color },
          ])
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
                { id: newAnnotationId(), kind: 'circle', center: next[0], radius: r, color },
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
            // DXF互換: 東+X からCCW（角度=atan2(北, 東) → atan2(p.x-c.x, p.y-c.y)）
            let startDeg = (Math.atan2(p1.x - c.x, p1.y - c.y) * 180) / Math.PI
            let endDeg = (Math.atan2(p2.x - c.x, p2.y - c.y) * 180) / Math.PI
            startDeg = ((startDeg % 360) + 360) % 360
            endDeg = ((endDeg % 360) + 360) % 360
            if (endDeg <= startDeg) endDeg += 360
            if (r > 0) {
              setAnnotations([
                ...annotations,
                { id: newAnnotationId(), kind: 'arc', center: next[0], radius: r, startDeg, endDeg, color },
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
            setMeasureResult({ kind: 'dist', value: d })
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
            setMeasureResult({ kind: 'perp', value: d })
            setTempVerts([])
          } else {
            setTempVerts(next)
          }
          break
        }
        case 'text':
        case 'comment': {
          const text = window.prompt(
            tool === 'text' ? '表示する文字列' : 'コメント',
            '',
          )
          if (text && text.trim()) {
            setAnnotations([
              ...annotations,
              tool === 'text'
                ? { id: newAnnotationId(), kind: 'text', pos: ll, text: text.trim(), color }
                : { id: newAnnotationId(), kind: 'comment', pos: ll, text: text.trim(), color },
            ])
          }
          // 連続入力できるよう道具は維持
          break
        }
        default:
          break
      }
    },
    dblclick() {
      if (tool === 'line') finalizeLine()
      else if (tool === 'polygon') finalizePolygon()
      else if (tool === 'measure-area') finalizeMeasureArea()
    },
  })

  // 道具切替や ESC で作図を中断するためのキーリスナー
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTempVerts([])
      } else if (e.key === 'Enter') {
        if (tool === 'line') finalizeLine()
        else if (tool === 'polygon') finalizePolygon()
        else if (tool === 'measure-area') finalizeMeasureArea()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, tempVerts, annotations, color])

  // ダブルクリックでズームしないように
  useEffect(() => {
    if (tool === 'line' || tool === 'polygon' || tool === 'measure-area') {
      map.doubleClickZoom.disable()
    } else {
      map.doubleClickZoom.enable()
    }
  }, [map, tool])

  // 注釈の削除（消去モード）
  const handleDelete = (id: string) => {
    if (tool !== 'erase') return
    if (!confirm('この図形を削除しますか？')) return
    setAnnotations(annotations.filter((a) => a.id !== id))
  }
  const deletableProps = (id: string) =>
    tool === 'erase'
      ? { eventHandlers: { click: () => handleDelete(id) } }
      : {}

  // 残りの計測結果バナーを地図上に重ねるためのオフセット位置（地図中心）
  void measureResult // 表示は親側で行う（地図上の値ラベルだけここで描く）

  return (
    <>
      {/* 保存済み図形 */}
      {annotations.map((a) => {
        if (a.kind === 'point') {
          return <Marker key={a.id} position={a.pos} icon={dotIcon(a.color)} {...deletableProps(a.id)} />
        }
        if (a.kind === 'line') {
          return (
            <Polyline
              key={a.id}
              positions={a.vertices}
              pathOptions={{ color: a.color, weight: 3, opacity: 0.9 }}
              {...deletableProps(a.id)}
            />
          )
        }
        if (a.kind === 'polygon') {
          return (
            <Polygon
              key={a.id}
              positions={a.vertices}
              pathOptions={{ color: a.color, fillColor: a.color, fillOpacity: 0.2, weight: 2 }}
              {...deletableProps(a.id)}
            />
          )
        }
        if (a.kind === 'circle') {
          return (
            <Circle
              key={a.id}
              center={a.center}
              radius={a.radius}
              pathOptions={{ color: a.color, fillColor: a.color, fillOpacity: 0.1, weight: 2 }}
              {...deletableProps(a.id)}
            />
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
            <Polyline
              key={a.id}
              positions={pts}
              pathOptions={{ color: a.color, weight: 2, opacity: 0.9 }}
              {...deletableProps(a.id)}
            />
          )
        }
        if (a.kind === 'text') {
          return <Marker key={a.id} position={a.pos} icon={textIcon(a.text, a.color)} {...deletableProps(a.id)} />
        }
        // comment
        return <Marker key={a.id} position={a.pos} icon={commentIcon(a.text, a.color)} {...deletableProps(a.id)} />
      })}

      {/* 作図中（途中）の表示 */}
      {tempVerts.length > 0 && (
        <>
          {(tool === 'line' || tool === 'measure-dist' || tool === 'measure-perp') && tempVerts.length >= 2 && (
            <Polyline positions={tempVerts} pathOptions={{ color, weight: 2, dashArray: '4,3' }} />
          )}
          {(tool === 'polygon' || tool === 'measure-area') && tempVerts.length >= 2 && (
            <Polyline positions={tempVerts} pathOptions={{ color, weight: 2, dashArray: '4,3' }} />
          )}
          {tempVerts.map((v, i) => (
            <CircleMarker
              key={`tv-${i}`}
              center={v}
              radius={4}
              pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 1 }}
            />
          ))}
        </>
      )}
    </>
  )
}

// 計測結果のフォーマット（親で利用）
export function formatMeasure(r: MeasureResult): string {
  if (r.kind === 'area') {
    const ha = r.value / 10000
    return `${r.value.toFixed(2)} m² （${ha.toFixed(4)} ha）`
  }
  if (r.value < 1) return `${(r.value * 100).toFixed(1)} cm`
  return `${r.value.toFixed(3)} m`
}

// ツール一覧（親のツールバーで利用）
export const TOOL_LIST: { tool: ToolMode; label: string; help?: string }[] = [
  { tool: 'none', label: '選択' },
  { tool: 'point', label: '点' },
  { tool: 'line', label: '線', help: 'クリックで頂点追加 / ダブルクリックで終了' },
  { tool: 'polygon', label: '面', help: 'クリックで頂点追加 / ダブルクリックで閉じる' },
  { tool: 'circle', label: '円', help: '中心 → 半径点 の順にクリック' },
  { tool: 'arc', label: '円弧', help: '中心 → 始点 → 終点（CCW方向）の順にクリック' },
  { tool: 'text', label: '文字', help: 'クリック位置に文字列を配置' },
  { tool: 'comment', label: 'コメント', help: 'クリック位置にコメントを配置' },
  { tool: 'measure-dist', label: '距離', help: '2点をクリック' },
  { tool: 'measure-area', label: '面積', help: 'クリックで頂点 / ダブルクリックで閉じる' },
  { tool: 'measure-perp', label: '垂線', help: '線の2点→対象1点の順にクリック' },
  { tool: 'erase', label: '削除', help: '図形をクリックで削除' },
]
