// 線形物（水路・道路）— 線形登録ページ
//
// - 工区ごとに複数の線形物を登録可能
// - 各線形物は平面線形（BP→IP→EP、IP は角 or 単曲線 R）+ 縦断 + 標準断面で定義
// - 標準断面は中心から右/左に並ぶ要素列（幅・勾配[1:i または %]）
// - 座標管理の点を参照する
// - 地図で線形（直線 + 曲線）をプレビュー

import { useEffect, useMemo, useRef, useState } from 'react'
import { Polyline, CircleMarker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Pencil, Check, X } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { useFarmStore } from '@/stores/farmStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import {
  useOpenChannelStore,
  type AlignmentPoint,
  type AlignmentPointKind,
  type ProfilePoint,
  type CrossSectionElement,
  type SlopeUnit,
  type StandardCrossSection,
  type StationRow,
  type SideOrientation,
  buildCrossSectionPath,
  formatSlope,
  elementStep,
} from '@/stores/openChannelStore'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  sampleAlignment,
  alignmentTotalLength,
  buildSegments,
  pointAtDistance,
  tangentAtDistance,
  getCurveMarkers,
  getCornerIpStations,
  type AlignmentSegment,
  type AlignmentVertex,
  type CurveMarker,
} from '@/lib/openChannel/alignment'
import { downloadSimaFile, type SimaExportPoint } from '@/lib/sima-parser'
import { buildLandXml } from '@/lib/landxml/exporter'
import type {
  Alignment as LandXmlAlignment,
  AlignmentSegment as LandXmlAlignmentSegment,
} from '@/lib/landxml/types'
import { clothoidPoint, clothoidPointOut } from '@/lib/clothoid'
import type { TinPoint, TinTriangle, TinSurface } from '@/lib/landxml/surface'

/**
 * 中間点 1 つの断面要素境界点を、平面座標 (x_north, y_east) + 標高 z にプロジェクションして返す。
 *
 * - sideOrientation='forward': BP→EP を見て右が +、左が -
 * - sideOrientation='reverse': EP→BP を見て右が +、左が -
 * - 標高 z = 中心線床高（profile_points を線形補間） + 断面要素累積高さ
 * - 直立要素 (slopeUnit='vertical') は水平移動 0 (前頂点と同じ平面位置に重なる)。
 */
type StationVertex = {
  x: number
  y: number
  z: number
  offset: number // 中心からの符号付き水平距離 (m)、正=ユーザー視点の右
  localH: number // 中心床高からの局所高さ (m)
  label: string
  side: 'right' | 'left' | 'center'
}

function interpolateProfileZ(
  profilePoints: ProfilePoint[],
  distance: number,
): number {
  if (profilePoints.length === 0) return 0
  const sorted = [...profilePoints].sort((a, b) => a.distance - b.distance)
  if (distance <= sorted[0].distance) return sorted[0].floorHeight
  const last = sorted[sorted.length - 1]
  if (distance >= last.distance) return last.floorHeight
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (distance >= a.distance && distance <= b.distance) {
      const dx = b.distance - a.distance
      if (dx < 1e-9) return a.floorHeight
      const t = (distance - a.distance) / dx
      return a.floorHeight + (b.floorHeight - a.floorHeight) * t
    }
  }
  return last.floorHeight
}

function computeStationVertices(
  station: StationRow,
  standardCS: StandardCrossSection,
  profilePoints: ProfilePoint[],
  segments: AlignmentSegment[],
  sideOrientation: SideOrientation,
): StationVertex[] {
  const cs = station.crossSection ?? standardCS
  const center = pointAtDistance(segments, station.distance)
  const tangent = tangentAtDistance(segments, station.distance)
  if (!center || !tangent) return []
  const sign = sideOrientation === 'forward' ? 1 : -1
  // (x=北, y=東) 系で進行方向 (tx, ty) の CCW 90° = (-ty, tx) が地図上の進行方向の右。
  // sign=-1 で河川向き（EP→BP 視点の右 = BP→EP 視点の左）に反転。
  const perp = { x: -tangent.y * sign, y: tangent.x * sign }
  const centerZ = interpolateProfileZ(profilePoints, station.distance)
  const out: StationVertex[] = [
    {
      x: center.x,
      y: center.y,
      z: centerZ,
      offset: 0,
      localH: 0,
      label: 'CL',
      side: 'center',
    },
  ]
  let cum = 0
  let localH = 0
  for (let i = 0; i < cs.right.length; i++) {
    const e = cs.right[i]
    const step = elementStep(e, 1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `R${i + 1}`,
      side: 'right',
    })
  }
  cum = 0
  localH = 0
  for (let i = 0; i < cs.left.length; i++) {
    const e = cs.left[i]
    const step = elementStep(e, -1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `L${i + 1}`,
      side: 'left',
    })
  }
  return out
}

/**
 * 位置から 線形点の 種別 (BP/IP/EP) を 決定。
 *   先頭 (index=0) → BP
 *   末尾 (index=total-1) → EP
 *   その間 → IP
 * (1 点しか ない 場合 は BP 扱い)
 */
function inferKindByIndex(index: number, total: number): AlignmentPointKind {
  if (total <= 1) return 'bp'
  if (index === 0) return 'bp'
  if (index === total - 1) return 'ep'
  return 'ip'
}

/**
 * alignmentPoints 配列の 全要素 の kind を 位置から 再計算 して 返す。
 * ユーザー が 追加/削除/並べ替え した ときに 必ず 通す。
 */
function normalizeKinds(points: AlignmentPoint[]): AlignmentPoint[] {
  const n = points.length
  return points.map((p, i) => ({ ...p, kind: inferKindByIndex(i, n) }))
}

/**
 * 数値入力（途中の "-" や "1." も受け入れる）。
 * 親 state には数値として確定した瞬間に通知し、表示は手元のテキストを優先する。
 */
function NumberInput({
  value,
  onChange,
  step,
  className,
  disabled,
  placeholder,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  className?: string
  disabled?: boolean
  placeholder?: string
}) {
  const [text, setText] = useState<string>(() => String(value))
  const lastEmitted = useRef<number>(value)

  // 外部から value が変わったときは表示を同期（自分が onChange した結果と同値なら無視）
  useEffect(() => {
    if (value === lastEmitted.current) return
    setText(String(value))
    lastEmitted.current = value
  }, [value])

  return (
    <input
      type="text"
      inputMode="decimal"
      step={step}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        if (t === '' || t === '-' || t === '.' || t === '-.') return
        const v = parseFloat(t)
        if (Number.isFinite(v)) {
          lastEmitted.current = v
          onChange(v)
        }
      }}
      onBlur={() => {
        const v = parseFloat(text)
        if (Number.isFinite(v)) {
          lastEmitted.current = v
          onChange(v)
          setText(String(v))
        } else {
          setText(String(value))
        }
      }}
    />
  )
}

/** タイトルのみで折りたたみ可能なセクション（開閉状態は localStorage に記憶可）。
 *  onOpenChange を 渡すと 親コンポーネントが 現在の 開閉状態を 監視できる
 *  (例: 折りたたみ中は 地図クリック による 編集を 抑止 する 用途)。 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  storageKey,
  onOpenChange,
  children,
}: {
  title: string
  defaultOpen?: boolean
  storageKey?: string
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (storageKey && typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey)
      if (v === '1') return true
      if (v === '0') return false
    }
    return defaultOpen
  })
  // 開閉状態が 変わる たびに 親へ 通知 (初回 マウント 時も 発火 する)
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev
      if (storageKey && typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, next ? '1' : '0')
      }
      return next
    })
  }
  return (
    <section className="bg-white rounded-lg border">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-3 py-2 flex items-center font-semibold text-slate-800 text-sm hover:bg-slate-50 rounded-t-lg"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mr-1 text-slate-500" />
        ) : (
          <ChevronRight className="h-4 w-4 mr-1 text-slate-500" />
        )}
        <span>{title}</span>
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </section>
  )
}

// マウント時に 1 度だけ フィットする。線形点を 編集する たびに 位置が
// 動くと 使いづらいため、線形物を 切り替えた ときだけ 再フィット させたい。
// 呼び出し側で <FitBounds key={selectedId} ... /> と 書けば、選択切替で
// アンマウント→再マウント され、初回だけ 1 度 フィットする。
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    if (positions.length < 2) return
    const bounds = L.latLngBounds(positions)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 })
    done.current = true
  }, [positions, map])
  return null
}

// 標準断面の図（流れ方向を見た形）— 中心から左右へ並ぶ要素列を折れ線で描画
function CrossSectionDiagram({ cs }: { cs: StandardCrossSection }) {
  const points = buildCrossSectionPath(cs)
  if (points.length < 2) {
    return (
      <div
        className="border rounded bg-slate-50 text-xs text-slate-400 px-2 py-3 text-center"
        style={{ width: 360 }}
      >
        左右いずれかに断面要素を追加してください
      </div>
    )
  }

  const widthPx = 360
  const heightPx = 200
  const padding = { top: 18, right: 14, bottom: 30, left: 14 }
  const innerW = widthPx - padding.left - padding.right
  const innerH = heightPx - padding.top - padding.bottom

  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs, -0.5)
  const maxX = Math.max(...xs, 0.5)
  const minY = Math.min(...ys, -0.1)
  const maxY = Math.max(...ys, 0.1)
  const spanX = Math.max(maxX - minX, 0.01)
  const spanY = Math.max(maxY - minY, 0.01)
  // 縦横の比率を保つ等方スケーリング
  const scale = Math.min(innerW / spanX, innerH / spanY)
  const drawnW = spanX * scale
  const drawnH = spanY * scale
  const offsetX = padding.left + (innerW - drawnW) / 2 - minX * scale
  const offsetY = padding.top + (innerH - drawnH) / 2 + maxY * scale

  const tx = (x: number) => offsetX + x * scale
  const ty = (y: number) => offsetY - y * scale

  // 折れ線パス
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`).join(' ')

  // 各セグメントのラベル位置（右/左を別計算）
  type Seg = { from: { x: number; y: number }; to: { x: number; y: number }; e: CrossSectionElement }
  const segs: Seg[] = []
  let cx = 0
  let cy = 0
  for (const e of cs.right) {
    const from = { x: cx, y: cy }
    const { dx, dy } = elementStep(e, 1)
    cx += dx
    cy += dy
    segs.push({ from, to: { x: cx, y: cy }, e })
  }
  cx = 0
  cy = 0
  for (const e of cs.left) {
    const from = { x: cx, y: cy }
    const { dx, dy } = elementStep(e, -1)
    cx += dx
    cy += dy
    segs.push({ from, to: { x: cx, y: cy }, e })
  }

  return (
    <svg width={widthPx} height={heightPx} className="border rounded bg-slate-50">
      {/* 中心線 */}
      <line
        x1={tx(0)}
        y1={padding.top}
        x2={tx(0)}
        y2={heightPx - padding.bottom}
        stroke="#cbd5e1"
        strokeDasharray="3,3"
        strokeWidth={1}
      />
      {/* 標高基準（y=0 水平線） */}
      <line
        x1={padding.left}
        y1={ty(0)}
        x2={widthPx - padding.right}
        y2={ty(0)}
        stroke="#e2e8f0"
        strokeWidth={1}
      />

      {/* 断面ライン */}
      <path d={pathD} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeLinejoin="round" />

      {/* セグメントごとのラベル */}
      {segs.map((s, i) => {
        const mx = (tx(s.from.x) + tx(s.to.x)) / 2
        const my = (ty(s.from.y) + ty(s.to.y)) / 2
        const slopeStr = formatSlope(s.e)
        const label = s.e.name
          ? `${s.e.name} ${s.e.width.toFixed(2)}m ${slopeStr}`
          : `${s.e.width.toFixed(2)}m ${slopeStr}`
        return (
          <text
            key={i}
            x={mx}
            y={my - 6}
            textAnchor="middle"
            fontSize={9}
            fill="#475569"
            style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
          >
            {label}
          </text>
        )
      })}

      {/* 各折点 */}
      {points.map((p, i) => (
        <circle
          key={`v-${i}`}
          cx={tx(p.x)}
          cy={ty(p.y)}
          r={2.5}
          fill={Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9 ? '#0ea5e9' : '#fff'}
          stroke="#0ea5e9"
          strokeWidth={1.5}
        />
      ))}

      {/* 左右ラベル */}
      <text x={padding.left} y={padding.top + 10} fontSize={9} fill="#94a3b8">
        左
      </text>
      <text x={widthPx - padding.right - 10} y={padding.top + 10} fontSize={9} fill="#94a3b8">
        右
      </text>
    </svg>
  )
}

// 縦断図（追加距離 vs 計画高）
function ProfileChart({ points, totalLen }: { points: ProfilePoint[]; totalLen: number }) {
  const widthPx = 280
  const heightPx = 140
  const padding = { top: 10, right: 14, bottom: 24, left: 38 }
  const innerW = widthPx - padding.left - padding.right
  const innerH = heightPx - padding.top - padding.bottom

  if (points.length < 2) {
    return (
      <div className="border rounded bg-slate-50 text-xs text-slate-400 px-2 py-3 text-center" style={{ width: widthPx }}>
        変化点が 2 点以上で縦断図を表示
      </div>
    )
  }
  const sorted = [...points].sort((a, b) => a.distance - b.distance)
  const minH = Math.min(...sorted.map((p) => p.floorHeight))
  const maxH = Math.max(...sorted.map((p) => p.floorHeight))
  const rangeRaw = maxH - minH
  const range = rangeRaw < 1e-6 ? 1 : rangeRaw
  const maxDist = Math.max(totalLen, sorted[sorted.length - 1].distance)
  const minDist = Math.min(0, sorted[0].distance)
  const distSpan = Math.max(maxDist - minDist, 1)

  const tx = (d: number) => padding.left + ((d - minDist) / distSpan) * innerW
  const ty = (h: number) => padding.top + (1 - (h - minH) / range) * innerH

  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.distance)} ${ty(p.floorHeight)}`).join(' ')

  // Y 軸目盛
  const yStep = range > 5 ? 1 : range > 2 ? 0.5 : range > 0.5 ? 0.2 : 0.1
  const yTicks: number[] = []
  for (let h = Math.ceil(minH / yStep) * yStep; h <= maxH + 1e-9; h += yStep) yTicks.push(h)

  // X 軸目盛
  const xStep = distSpan > 200 ? 50 : distSpan > 80 ? 20 : distSpan > 30 ? 10 : 5
  const xTicks: number[] = []
  for (let d = Math.ceil(minDist / xStep) * xStep; d <= maxDist + 1e-9; d += xStep) xTicks.push(d)

  return (
    <svg width={widthPx} height={heightPx} className="border rounded bg-slate-50">
      {/* 枠 */}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + innerH} stroke="#94a3b8" strokeWidth={1} />
      <line x1={padding.left} y1={padding.top + innerH} x2={padding.left + innerW} y2={padding.top + innerH} stroke="#94a3b8" strokeWidth={1} />

      {/* Y 軸グリッド + ラベル */}
      {yTicks.map((h, i) => (
        <g key={`y-${i}`}>
          <line x1={padding.left} y1={ty(h)} x2={padding.left + innerW} y2={ty(h)} stroke="#e2e8f0" strokeWidth={1} />
          <text x={padding.left - 4} y={ty(h) + 3} textAnchor="end" fontSize={9} fill="#64748b">{h.toFixed(2)}</text>
        </g>
      ))}

      {/* X 軸ラベル */}
      {xTicks.map((d, i) => (
        <g key={`x-${i}`}>
          <line x1={tx(d)} y1={padding.top + innerH} x2={tx(d)} y2={padding.top + innerH + 3} stroke="#94a3b8" strokeWidth={1} />
          <text x={tx(d)} y={padding.top + innerH + 12} textAnchor="middle" fontSize={9} fill="#64748b">{d}</text>
        </g>
      ))}

      {/* 床高ライン */}
      <path d={path} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {/* 点 */}
      {sorted.map((p, i) => (
        <circle key={`p-${i}`} cx={tx(p.distance)} cy={ty(p.floorHeight)} r={3} fill="#0ea5e9" stroke="#fff" strokeWidth={1.5} />
      ))}

      {/* 勾配ラベル */}
      {sorted.slice(1).map((p, i) => {
        const prev = sorted[i]
        const dx = p.distance - prev.distance
        const dy = p.floorHeight - prev.floorHeight
        if (Math.abs(dx) < 1e-6) return null
        const slope = Math.abs(dy) < 1e-9 ? '水平' : `1/${Math.round(Math.abs(dx / dy))}`
        const mx = (tx(prev.distance) + tx(p.distance)) / 2
        const my = (ty(prev.floorHeight) + ty(p.floorHeight)) / 2 - 6
        return <text key={`s-${i}`} x={mx} y={my} textAnchor="middle" fontSize={9} fill="#475569">{slope}</text>
      })}

      {/* 軸単位 */}
      <text x={5} y={padding.top - 2} fontSize={9} fill="#64748b">計画高 (m)</text>
      <text x={widthPx - 4} y={heightPx - 4} textAnchor="end" fontSize={9} fill="#64748b">距離 (m)</text>
    </svg>
  )
}

// 標準断面の片側（右 or 左）の要素列エディタ
function CrossSectionSideEditor({
  side,
  elements,
  onChange,
}: {
  side: 'right' | 'left'
  elements: CrossSectionElement[]
  onChange: (els: CrossSectionElement[]) => void
}) {
  const sideLabel = side === 'right' ? '右側' : '左側'

  const updateAt = (idx: number, patch: Partial<CrossSectionElement>) => {
    onChange(elements.map((e, i) => (i === idx ? { ...e, ...patch } : e)))
  }
  const removeAt = (idx: number) => onChange(elements.filter((_, i) => i !== idx))
  const moveAt = (idx: number, dir: -1 | 1) => {
    const tgt = idx + dir
    if (tgt < 0 || tgt >= elements.length) return
    const arr = elements.slice()
    const tmp = arr[idx]
    arr[idx] = arr[tgt]
    arr[tgt] = tmp
    onChange(arr)
  }
  const addOne = () => {
    const el: CrossSectionElement = {
      id: `e${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: '',
      width: 1.0,
      slopeValue: 0,
      slopeUnit: 'percent',
    }
    onChange([...elements, el])
  }

  return (
    <div className="border rounded">
      <div className="bg-slate-50 px-2 py-1 text-xs flex items-center">
        <span className="font-semibold text-slate-700">{sideLabel}（中心 → 外側）</span>
        <button
          onClick={addOne}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100"
        >
          <Plus className="h-3 w-3" />
          要素追加
        </button>
      </div>
      {elements.length === 0 ? (
        <div className="px-2 py-2 text-[11px] text-slate-400">要素がありません</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-1 py-1 w-6 text-center">#</th>
              <th className="px-1 py-1 text-left">種別</th>
              <th className="px-1 py-1 text-right w-14">幅(m)</th>
              <th className="px-1 py-1 text-right w-16">勾配/高さ</th>
              <th className="px-1 py-1 text-center w-16">単位</th>
              <th className="px-1 py-1 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {elements.map((el, i) => {
              const isVertical = el.slopeUnit === 'vertical'
              return (
                <tr key={el.id} className="border-t">
                  <td className="px-1 py-1 text-center text-slate-500">{i + 1}</td>
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      value={el.name}
                      onChange={(e) => updateAt(i, { name: e.target.value })}
                      placeholder="例: 床 / 法面 / 路面"
                      className="w-full px-1 py-0.5 border rounded text-xs"
                    />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <NumberInput
                      step={0.05}
                      value={isVertical ? 0 : el.width}
                      disabled={isVertical}
                      onChange={(v) => {
                        if (v >= 0) updateAt(i, { width: v })
                      }}
                      className="w-14 px-1 py-0.5 border rounded text-right text-xs disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <NumberInput
                      step={el.slopeUnit === 'percent' ? 0.1 : 0.05}
                      value={el.slopeValue}
                      onChange={(v) => updateAt(i, { slopeValue: v })}
                      className="w-16 px-1 py-0.5 border rounded text-right text-xs"
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <select
                      value={el.slopeUnit}
                      onChange={(e) => updateAt(i, { slopeUnit: e.target.value as SlopeUnit })}
                      className="px-1 py-0.5 border rounded text-xs"
                    >
                      <option value="ratio">1:i</option>
                      <option value="percent">%</option>
                      <option value="vertical">直立 m</option>
                    </select>
                  </td>
                <td className="px-1 py-1 text-right">
                  <div className="flex gap-0.5 justify-end">
                    <button
                      onClick={() => moveAt(i, -1)}
                      disabled={i === 0}
                      className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => moveAt(i, 1)}
                      disabled={i === elements.length - 1}
                      className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => removeAt(i)}
                      className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function OpenChannelAlignmentPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { channels, fetchChannels, addChannel, updateChannel, deleteChannel } = useOpenChannelStore()

  const farmId = currentFarm?.id
  useEffect(() => {
    if (!farmId) return
    fetchCoordinates(farmId)
    fetchChannels(farmId)
  }, [farmId, fetchCoordinates, fetchChannels])

  // 座標系
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    return projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (!selectedId && channels.length > 0) setSelectedId(channels[0].id)
    if (selectedId && !channels.find((c) => c.id === selectedId)) setSelectedId(channels[0]?.id ?? null)
  }, [channels, selectedId])

  const selected = channels.find((c) => c.id === selectedId) ?? null

  // 線形点を解決して XY 列に変換。
  // 種別 (BP/IP/EP) は 位置から 自動決定 (先頭=BP、末尾=EP、中間=IP)。
  const alignmentXY = useMemo<AlignmentVertex[]>(() => {
    if (!selected) return []
    const out: AlignmentVertex[] = []
    const total = selected.alignmentPoints.length
    for (let i = 0; i < total; i++) {
      const p = selected.alignmentPoints[i]
      const c = coordinates.find((cc) => cc.id === p.coordId)
      if (!c) continue
      out.push({
        x: c.x,
        y: c.y,
        kind: inferKindByIndex(i, total),
        radius: p.radius,
        spiralAIn: p.spiralAIn,
        spiralAOut: p.spiralAOut,
      })
    }
    return out
  }, [selected, coordinates])

  const sampledXY = useMemo(() => sampleAlignment(alignmentXY, 64), [alignmentXY])
  const segments = useMemo(() => buildSegments(alignmentXY), [alignmentXY])
  const totalLen = useMemo(() => alignmentTotalLength(alignmentXY), [alignmentXY])

  // 描画用 lat/lng
  const sampledLatLng = useMemo<[number, number][]>(() => {
    return sampledXY.map((p) => {
      const r = converter.toLatLng(p.x, p.y)
      return [r.lat, r.lng]
    })
  }, [sampledXY, converter])

  // 線形点として 登録済みの 座標 ID 集合。CoordinateMap の checkedCoordIds に
  // 渡して スカイブルーの ハローで 強調 (座標管理と 同じ 選択済み表現)。
  const registeredCoordIds = useMemo(() => {
    if (!selected) return new Set<string>()
    return new Set(selected.alignmentPoints.map((p) => p.coordId))
  }, [selected])

  // 線形点セクション の 開閉状態。折りたたみ 中は 地図クリック 追加を 抑止 する。
  // 初期値 は CollapsibleSection と 同じく localStorage を 見る (デフォルト = 開)。
  const [linearPointsExpanded, setLinearPointsExpanded] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('oc:section:linear-points')
      if (v === '0') return false
    }
    return true
  })

  // 線形点の追加: 座標を選択 (種別 BP/IP/EP は 位置から 自動決定)
  const [addCoordId, setAddCoordId] = useState<string>('')
  const [addRadius, setAddRadius] = useState<number>(0)

  const handleAddPoint = () => {
    if (!selected || !addCoordId) return
    const next: AlignmentPoint[] = normalizeKinds([
      ...selected.alignmentPoints,
      { coordId: addCoordId, kind: 'ip', radius: addRadius > 0 ? addRadius : undefined },
    ])
    updateChannel(selected.id, { alignmentPoints: next })
    setAddCoordId('')
  }

  // 地図でクリックした 座標を そのまま 線形点として 追加。
  // 線形点セクション が 折りたたまれて いる 時は 編集 不可 (誤操作 防止)。
  // 既登録の 座標は 何もしない (トグル 挙動は 誤操作の 元なので しない)。
  const handlePickCoordFromMap = (coordId: string) => {
    if (!selected) return
    if (!linearPointsExpanded) return
    if (selected.alignmentPoints.some((p) => p.coordId === coordId)) return
    const next: AlignmentPoint[] = normalizeKinds([
      ...selected.alignmentPoints,
      { coordId, kind: 'ip', radius: addRadius > 0 ? addRadius : undefined },
    ])
    updateChannel(selected.id, { alignmentPoints: next })
  }

  const handleMovePoint = (idx: number, dir: -1 | 1) => {
    if (!selected) return
    const arr = selected.alignmentPoints.slice()
    const target = idx + dir
    if (target < 0 || target >= arr.length) return
    const tmp = arr[idx]
    arr[idx] = arr[target]
    arr[target] = tmp
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  const handleRemovePoint = (idx: number) => {
    if (!selected) return
    const arr = selected.alignmentPoints.filter((_, i) => i !== idx)
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  const handleChangePoint = (idx: number, patch: Partial<AlignmentPoint>) => {
    if (!selected) return
    const arr = selected.alignmentPoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  // 線形物の 名前 編集 (ヘッダー の 鉛筆ボタン で 切替)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const handleStartEditName = () => {
    if (!selected) return
    setNameDraft(selected.name)
    setEditingName(true)
  }
  const handleSaveName = () => {
    if (!selected) return
    const next = nameDraft.trim()
    if (next && next !== selected.name) updateChannel(selected.id, { name: next })
    setEditingName(false)
  }
  const handleCancelEditName = () => setEditingName(false)
  // 線形物 を 切り替えたら 編集モード は 解除
  useEffect(() => {
    setEditingName(false)
  }, [selectedId])

  // 縦断線形（profile）操作
  const [addProfileDist, setAddProfileDist] = useState<number>(0)
  const [addProfileH, setAddProfileH] = useState<number>(0)
  const [showAddProfile, setShowAddProfile] = useState(false)

  const sortedProfile = useMemo<ProfilePoint[]>(() => {
    if (!selected) return []
    return [...selected.profilePoints].sort((a, b) => a.distance - b.distance)
  }, [selected])

  const handleAddProfile = () => {
    if (!selected) return
    const next: ProfilePoint[] = [...selected.profilePoints, { distance: addProfileDist, floorHeight: addProfileH }]
    next.sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { profilePoints: next })
    setAddProfileDist(0)
    setAddProfileH(0)
  }
  const handleRemoveProfile = (idx: number) => {
    if (!selected) return
    const arr = selected.profilePoints.filter((_, i) => i !== idx)
    updateChannel(selected.id, { profilePoints: arr })
  }
  const handleChangeProfile = (idx: number, patch: Partial<ProfilePoint>) => {
    if (!selected) return
    const arr = selected.profilePoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    arr.sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { profilePoints: arr })
  }

  // 中間点計算（任意 SP / ピッチ割）
  const [stationMode, setStationMode] = useState<'sp' | 'pitch'>('sp')
  const [stationDist, setStationDist] = useState<number>(0)
  const [stationPitch, setStationPitch] = useState<number>(20)
  const [includeEp, setIncludeEp] = useState<boolean>(true)
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null)

  const stations: StationRow[] = selected?.stations ?? []
  const selectedStation = stations.find((s) => s.id === selectedStationId) ?? null

  const formatSp = (d: number) => `SP${d.toFixed(2)}`
  const formatBc = (d: number) => `BC${d.toFixed(2)}`
  const formatEc = (d: number) => `EC${d.toFixed(2)}`
  const formatBtc = (d: number) => `BTC${d.toFixed(2)}`
  const formatEtc = (d: number) => `ETC${d.toFixed(2)}`
  const formatIp = (d: number) => `IP${d.toFixed(2)}`

  // getCurveMarkers が 返す 6 種類の マーカー を、ユーザー が 見慣れた
  // ラベル に 変換する。 単曲線 の 両端は BC/EC、緩和曲線 の 外側端は
  // BTC/ETC (Beginning/End of Transition Curve)、緩和曲線 内側 (arc と の 接続) は
  // BC/EC (arc の 起終点 として 扱う)。
  const formatCurveMarker = (kind: CurveMarker['kind'], distance: number): string => {
    switch (kind) {
      case 'bc':
        return formatBc(distance)
      case 'ec':
        return formatEc(distance)
      case 'ts':
        return formatBtc(distance)
      case 'st':
        return formatEtc(distance)
      case 'sc':
        return formatBc(distance)
      case 'cs':
        return formatEc(distance)
    }
  }

  const newStationId = () =>
    `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const newElementId = () =>
    `e${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const cloneCrossSection = (cs: StandardCrossSection): StandardCrossSection => ({
    right: cs.right.map((e) => ({ ...e, id: newElementId() })),
    left: cs.left.map((e) => ({ ...e, id: newElementId() })),
  })

  const setStations = (next: StationRow[]) => {
    if (!selected) return
    updateChannel(selected.id, { stations: next })
  }

  // 「特徴点」= IP (折点) / BC / EC / BTC / ETC の 集合。線形形状から 一意に決まる。
  const isFeatureLabel = (label: string) =>
    label.startsWith('IP') ||
    label.startsWith('BTC') ||
    label.startsWith('ETC') ||
    label.startsWith('BC') ||
    label.startsWith('EC')

  const collectFeaturePoints = (): { label: string; distance: number }[] => {
    const out: { label: string; distance: number }[] = []
    for (const m of getCurveMarkers(segments)) {
      out.push({ label: formatCurveMarker(m.kind, m.distance), distance: m.distance })
    }
    for (const m of getCornerIpStations(alignmentXY)) {
      out.push({ label: formatIp(m.distance), distance: m.distance })
    }
    return out
  }

  // 距離でソート + 同距離 (5mm 以内) を 特徴点 優先で 重複排除。
  const dedupeStations = (arr: StationRow[]): StationRow[] => {
    const sorted = [...arr].sort((a, b) => a.distance - b.distance)
    const merged: StationRow[] = []
    for (const s of sorted) {
      const prev = merged[merged.length - 1]
      if (prev && Math.abs(prev.distance - s.distance) < 5e-3) {
        if (isFeatureLabel(s.label) && !isFeatureLabel(prev.label)) {
          merged[merged.length - 1] = s
        }
        continue
      }
      merged.push(s)
    }
    return merged
  }

  const handleAddStation = () => {
    if (!selected || segments.length === 0) return
    if (stationMode === 'sp') {
      const d = Math.max(0, Math.min(stationDist, totalLen))
      const newRow: StationRow = {
        id: newStationId(),
        label: formatSp(d),
        distance: d,
        crossSection: null,
      }
      const next = [...stations, newRow].sort((a, b) => a.distance - b.distance)
      setStations(next)
    } else {
      const pitch = stationPitch
      if (!Number.isFinite(pitch) || pitch <= 0) return
      const out: StationRow[] = []
      const push = (label: string, distance: number) =>
        out.push({ id: newStationId(), label, distance, crossSection: null })

      let d = 0
      while (d <= totalLen + 1e-6) {
        const dist = Math.min(d, totalLen)
        push(formatSp(dist), dist)
        d += pitch
      }
      if (includeEp) {
        const last = out.length > 0 ? out[out.length - 1].distance : -1
        if (Math.abs(last - totalLen) > 1e-3) push(formatSp(totalLen), totalLen)
      }
      // 特徴点 (IP / BC / EC / BTC / ETC)
      for (const f of collectFeaturePoints()) push(f.label, f.distance)

      const merged = dedupeStations(out)

      // 既存の個別断面（crossSection != null）をラベル一致で引き継ぐ
      const existingByLabel = new Map(stations.map((s) => [s.label, s]))
      const final = merged.map((s) => {
        const ex = existingByLabel.get(s.label)
        if (ex && ex.crossSection) return { ...s, id: ex.id, crossSection: ex.crossSection }
        return s
      })
      setStations(final)
    }
  }

  // 現状の 中間点 リストに、線形形状 から 一意に決まる 特徴点 (IP / BC / EC /
  // BTC / ETC) を 追記する。既存 SP は 保持。同じ 追加距離 が 既に あれば
  // 特徴点ラベル で 置き換える。
  const handleAddFeaturePoints = () => {
    if (!selected || segments.length === 0) return
    const features = collectFeaturePoints()
    if (features.length === 0) return
    const featureRows: StationRow[] = features.map((f) => ({
      id: newStationId(),
      label: f.label,
      distance: f.distance,
      crossSection: null,
    }))
    setStations(dedupeStations([...stations, ...featureRows]))
  }

  const handleClearStations = () => {
    setStations([])
    setSelectedStationId(null)
  }
  const handleRemoveStation = (id: string) => {
    setStations(stations.filter((s) => s.id !== id))
    if (selectedStationId === id) setSelectedStationId(null)
  }
  const handleUpdateStationCrossSection = (
    id: string,
    crossSection: StandardCrossSection | null,
  ) => {
    setStations(stations.map((s) => (s.id === id ? { ...s, crossSection } : s)))
  }

  // 線形物を切り替えたら中間点選択をリセット
  useEffect(() => {
    setSelectedStationId(null)
  }, [selectedId])

  // 地図上の断面オーバーレイ表示モード
  type OverlayMode = 'none' | 'selected' | 'all'
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('all')

  // 各中間点の断面を平面に投影した頂点列をまとめて算出
  const stationVertexLists = useMemo(() => {
    if (!selected) return [] as { station: StationRow; vertices: StationVertex[] }[]
    return stations.map((s) => ({
      station: s,
      vertices: computeStationVertices(
        s,
        selected.standardCrossSection,
        selected.profilePoints,
        segments,
        selected.sideOrientation,
      ),
    }))
  }, [selected, stations, segments])

  // 表示対象を overlayMode で絞り込む
  const visibleStationVertices = useMemo(() => {
    if (overlayMode === 'none') return []
    if (overlayMode === 'selected')
      return stationVertexLists.filter((s) => s.station.id === selectedStationId)
    return stationVertexLists
  }, [stationVertexLists, overlayMode, selectedStationId])

  // ---- エクスポート ----

  /**
   * 各測点の断面頂点から TIN サーフェスを構築する。
   *
   * 断面ごとの頂点並び: [CL, R1, R2, ..., R_nR, L1, L2, ..., L_nL]
   * 隣接する 2 測点の同じ要素番号 k のセル（CL→R1→R2... または CL→L1→L2...）を四角形 → 2 三角形に分割する。
   * 個別断面で要素数が異なる測点間では、共通する分（min）までで打ち切る。
   *
   * 三角形の巻き向きは外積で判定し、平面 (x=北, y=東) の math-CCW 側を選ぶ
   * （LandXML エクスポータ側で b/c を入替して上空視点 CCW に揃える）。
   */
  const stationTin = useMemo<TinSurface | null>(() => {
    if (!selected) return null
    const sorted = stationVertexLists
      .filter((s) => s.vertices.length > 0)
      .sort((a, b) => a.station.distance - b.station.distance)
    if (sorted.length < 2) return null

    const points: TinPoint[] = []
    const stationPointIdx: number[][] = []
    for (const sv of sorted) {
      const idxs: number[] = []
      for (const v of sv.vertices) {
        idxs.push(points.length)
        points.push({ x: v.x, y: v.y, z: v.z, source: 'plan' })
      }
      stationPointIdx.push(idxs)
    }

    const triangles: TinTriangle[] = []
    const emitQuad = (iA: number, iA1: number, iB: number, iB1: number) => {
      if (iA === iA1 || iB === iB1) return
      const A = points[iA]
      const A1 = points[iA1]
      const B1 = points[iB1]
      const cross = (A1.x - A.x) * (B1.y - A.y) - (A1.y - A.y) * (B1.x - A.x)
      if (cross >= 0) {
        triangles.push({ a: iA, b: iA1, c: iB1 })
        triangles.push({ a: iA, b: iB1, c: iB })
      } else {
        triangles.push({ a: iA, b: iB1, c: iA1 })
        triangles.push({ a: iA, b: iB, c: iB1 })
      }
    }

    const csOf = (st: StationRow) =>
      st.crossSection ?? selected.standardCrossSection

    for (let s = 0; s < sorted.length - 1; s++) {
      const A = sorted[s]
      const B = sorted[s + 1]
      const aR = csOf(A.station).right.length
      const bR = csOf(B.station).right.length
      const aL = csOf(A.station).left.length
      const bL = csOf(B.station).left.length

      // Right strip: CL→R1→...→R_min(aR,bR)
      const nR = Math.min(aR, bR)
      for (let k = 0; k < nR; k++) {
        emitQuad(
          stationPointIdx[s][k],
          stationPointIdx[s][k + 1],
          stationPointIdx[s + 1][k],
          stationPointIdx[s + 1][k + 1],
        )
      }

      // Left strip: CL→L1→L2→...
      // 頂点並び [CL, R..., L...] のため L_i は index 1+aR+i-1 = aR+i (i は 1 始まり)
      const nL = Math.min(aL, bL)
      for (let k = 0; k < nL; k++) {
        const iA = k === 0 ? stationPointIdx[s][0] : stationPointIdx[s][aR + k]
        const iA1 = stationPointIdx[s][aR + k + 1]
        const iB = k === 0 ? stationPointIdx[s + 1][0] : stationPointIdx[s + 1][bR + k]
        const iB1 = stationPointIdx[s + 1][bR + k + 1]
        emitQuad(iA, iA1, iB, iB1)
      }
    }

    const zs = points.map((p) => p.z)
    return {
      points,
      triangles,
      stats: {
        pointCount: points.length,
        triangleCount: triangles.length,
        zMin: zs.length > 0 ? Math.min(...zs) : 0,
        zMax: zs.length > 0 ? Math.max(...zs) : 0,
      },
    }
  }, [selected, stationVertexLists])

  const handleExportSima = () => {
    if (!selected || stationVertexLists.length === 0) return
    const sorted = [...stationVertexLists].sort(
      (a, b) => a.station.distance - b.station.distance,
    )
    const points: SimaExportPoint[] = []
    for (const sv of sorted) {
      for (const v of sv.vertices) {
        points.push({
          pointNumber: `${sv.station.label}_${v.label}`,
          x: v.x,
          y: v.y,
          z: v.z,
        })
      }
    }
    if (points.length === 0) return
    const safeName = selected.name.replace(/[^\w\-_]/g, '_')
    downloadSimaFile(
      { projectName: selected.name, zone, points },
      `${safeName}_sections.sim`,
    )
  }

  // openChannel の AlignmentSegment を LandXML の AlignmentSegment 配列に変換
  const buildLandXmlAlignment = (): LandXmlAlignment | null => {
    if (!selected || segments.length === 0) return null
    const out: LandXmlAlignmentSegment[] = []
    for (const s of segments) {
      if (s.kind === 'line') {
        out.push({
          type: 'line',
          startX: s.p0.x,
          startY: s.p0.y,
          endX: s.p1.x,
          endY: s.p1.y,
          length: s.length,
        })
      } else if (s.kind === 'arc') {
        const startX = s.center.x + s.radius * Math.cos(s.a0)
        const startY = s.center.y + s.radius * Math.sin(s.a0)
        const endA = s.a0 + s.dA
        const endX = s.center.x + s.radius * Math.cos(endA)
        const endY = s.center.y + s.radius * Math.sin(endA)
        out.push({
          type: 'curve',
          startX,
          startY,
          endX,
          endY,
          length: s.length,
          centerX: s.center.x,
          centerY: s.center.y,
          radius: s.radius,
          rotation: s.dA >= 0 ? 'ccw' : 'cw',
        })
      } else {
        // spiral
        const R = (s.A * s.A) / s.length // L = A²/R → R = A²/L
        const startRadius = s.direction === 'in' ? null : R
        const endRadius = s.direction === 'in' ? R : null
        // 終点を計算（局所座標 → ワールド変換）
        const local =
          s.direction === 'in'
            ? clothoidPoint(s.length, s.A)
            : clothoidPointOut(s.length, s.A, s.length)
        const tx = s.tangent0.x
        const ty = s.tangent0.y
        const nxL = -ty
        const nyL = tx
        const yL = s.rotSign * local.y
        const endX = s.p0.x + tx * local.x + nxL * yL
        const endY = s.p0.y + ty * local.x + nyL * yL
        out.push({
          type: 'spiral',
          startX: s.p0.x,
          startY: s.p0.y,
          endX,
          endY,
          length: s.length,
          spiralType: 'clothoid',
          startRadius,
          endRadius,
          spiralA: s.A,
        })
      }
    }
    return {
      id: selected.id,
      name: selected.name,
      staStart: 0,
      totalLength: totalLen,
      segments: out,
    }
  }

  const handleExportLandXml = () => {
    if (!selected || !stationTin) return
    const lAlign = buildLandXmlAlignment()
    const xml = buildLandXml({
      alignments: lAlign ? [lAlign] : [],
      surfaces: [{ name: selected.name, surface: stationTin }],
      projectName: selected.name,
      coordinateZoneName: `JGD2011 zone ${zone}`,
    })
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safeName = selected.name.replace(/[^\w\-_]/g, '_')
    a.href = url
    a.download = `${safeName}_surface.xml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 標準断面" />
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">工区を選択してください</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 標準断面" />

      <div className="flex-1 flex overflow-hidden">
        {/* 左: 一覧 + 編集 */}
        <div className="w-[624px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
          {/* 線形点 (BP → IP → EP) — 一番上、折りたたみ 可能。
              折りたたみ 中は 地図クリック による 追加が 抑止 される。 */}
          <CollapsibleSection
            title={`線形点 (BP → IP → EP)${selected ? ` · ${selected.name}` : ''}`}
            storageKey="oc:section:linear-points"
            defaultOpen
            onOpenChange={setLinearPointsExpanded}
          >
            {/* 線形物 の 選択プルダウン + 名前編集 + 新規追加 + 削除 */}
            <div className="flex items-center gap-1">
              {editingName && selected ? (
                <>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName()
                      if (e.key === 'Escape') handleCancelEditName()
                    }}
                    className="flex-1 min-w-0 px-2 py-1 border rounded text-sm"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    title="保存"
                    className="shrink-0 p-1 border rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    title="キャンセル"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <select
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(e.target.value || null)}
                    className="flex-1 min-w-0 px-2 py-1 border rounded text-sm"
                  >
                    {channels.length === 0 && (
                      <option value="">（線形物なし）</option>
                    )}
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleStartEditName}
                    disabled={!selected}
                    title="名前を編集"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50 disabled:opacity-30"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => farmId && addChannel(farmId)}
                    title="新規追加"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (!selected) return
                      if (window.confirm(`「${selected.name}」を削除しますか？`)) deleteChannel(selected.id)
                    }}
                    disabled={!selected}
                    title="この線形物を削除"
                    className="shrink-0 p-1 border rounded text-red-600 hover:bg-red-50 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>

            {selected && (
              <>
                {/* 左右の基準方向 */}
                <div className="flex gap-1">
                  <button
                    onClick={() => updateChannel(selected.id, { sideOrientation: 'forward' })}
                    className={`flex-1 px-2 py-1 text-[11px] border rounded ${
                      selected.sideOrientation === 'forward'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    起点→終点を見て（道路）
                  </button>
                  <button
                    onClick={() => updateChannel(selected.id, { sideOrientation: 'reverse' })}
                    className={`flex-1 px-2 py-1 text-[11px] border rounded ${
                      selected.sideOrientation === 'reverse'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    終点→起点を見て（河川）
                  </button>
                </div>

                {/* 線形点テーブル (種別 は 位置から 自動決定: 先頭=BP、末尾=EP、中間=IP) */}
                {selected.alignmentPoints.length > 0 ? (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-600 text-xs">
                        <tr>
                          <th className="px-2 py-1 w-12 text-center">種別</th>
                          <th className="px-2 py-1 w-20 text-left">点名</th>
                          <th className="px-2 py-1 w-20 text-right">R (m)</th>
                          <th
                            className="px-2 py-1 w-16 text-right"
                            title="クロソイドパラメータ A（IN 側）。L=A²/R で緩和曲線長を決定"
                          >
                            A<sub>IN</sub>
                          </th>
                          <th
                            className="px-2 py-1 w-16 text-right"
                            title="クロソイドパラメータ A（OUT 側）"
                          >
                            A<sub>OUT</sub>
                          </th>
                          <th className="px-2 py-1 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.alignmentPoints.map((p, i) => {
                          const c = coordinates.find((cc) => cc.id === p.coordId)
                          const kind = inferKindByIndex(i, selected.alignmentPoints.length)
                          const kindLabel =
                            kind === 'bp' ? 'BP' : kind === 'ep' ? 'EP' : 'IP'
                          const kindColor =
                            kind === 'bp'
                              ? 'bg-green-100 text-green-700'
                              : kind === 'ep'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-amber-100 text-amber-700'
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-2 py-1 text-center">
                                <span
                                  className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold font-mono ${kindColor}`}
                                >
                                  {kindLabel}
                                </span>
                              </td>
                              <td className="px-2 py-1 truncate" title={c?.pointNumber ?? '？'}>
                                {c?.pointNumber ?? '？'}
                              </td>
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' ? (
                                  <input
                                    type="number"
                                    step={0.5}
                                    value={p.radius ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, { radius: Number.isFinite(v) && v > 0 ? v : undefined })
                                    }}
                                    className="w-16 px-1 py-0.5 border rounded text-right text-sm"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              {/* A_IN */}
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' && p.radius && p.radius > 0 ? (
                                  <input
                                    type="number"
                                    step={1}
                                    min={0}
                                    value={p.spiralAIn ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, {
                                        spiralAIn: Number.isFinite(v) && v > 0 ? v : undefined,
                                      })
                                    }}
                                    className="w-14 px-1 py-0.5 border rounded text-right text-sm"
                                    placeholder="0"
                                    title="0/空で緩和曲線なし"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              {/* A_OUT */}
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' && p.radius && p.radius > 0 ? (
                                  <input
                                    type="number"
                                    step={1}
                                    min={0}
                                    value={p.spiralAOut ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, {
                                        spiralAOut: Number.isFinite(v) && v > 0 ? v : undefined,
                                      })
                                    }}
                                    className="w-14 px-1 py-0.5 border rounded text-right text-sm"
                                    placeholder="0"
                                    title="0/空で緩和曲線なし"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <div className="flex gap-0.5 justify-end">
                                  <button
                                    onClick={() => handleMovePoint(i, -1)}
                                    disabled={i === 0}
                                    className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => handleMovePoint(i, 1)}
                                    disabled={i === selected.alignmentPoints.length - 1}
                                    className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => handleRemovePoint(i)}
                                    className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 text-center py-2 border rounded bg-slate-50">
                    線形点がありません。下のフォーム or 地図上の座標クリックで追加。
                  </div>
                )}

                {/* 末尾に 追加する インライン フォーム
                    (種別 は 位置から 自動決定: 先頭=BP、末尾=EP、中間=IP) */}
                <div className="grid grid-cols-12 gap-2 items-end pt-2 border-t">
                  <select
                    value={addCoordId}
                    onChange={(e) => setAddCoordId(e.target.value)}
                    className="col-span-8 px-2 py-1 border rounded text-sm"
                  >
                    <option value="">座標を選択…</option>
                    {(coordinates as CoordinateRow[]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pointNumber}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step={0.5}
                    value={addRadius}
                    onChange={(e) => setAddRadius(parseFloat(e.target.value) || 0)}
                    placeholder="R (IP用)"
                    title="IP になった 場合の 曲線半径 R (0=角折れ)"
                    className="col-span-2 px-2 py-1 border rounded text-sm text-right"
                  />
                  <button
                    onClick={handleAddPoint}
                    disabled={!addCoordId}
                    className="col-span-2 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    追加
                  </button>
                </div>
                <div className="text-xs text-slate-400">
                  💡 地図上の 座標を クリックしても 末尾に 追加できます
                  (既登録は スカイブルー ハロー で 強調)。
                </div>

                {/* 線形長 (以前の 独立セクションを ここに 統合) */}
                <div className="text-xs text-slate-500 pt-1 border-t">
                  線形長:{' '}
                  <span className="font-mono tabular-nums text-slate-700 text-sm">
                    {totalLen.toFixed(2)} m
                  </span>
                  <span className="text-[11px] text-slate-400 ml-2">
                    (直線・単曲線・クロソイド, L = A²/R)
                  </span>
                </div>
              </>
            )}
          </CollapsibleSection>

          {selected && (
            <>

              {/* 中間点計算 */}
              <CollapsibleSection title="中間点計算" storageKey="oc:section:stations">
                <div className="text-xs text-slate-500">
                  線形上の 任意位置の 座標を 算出します。BP からの 距離 (m) を SP 値として 扱います。
                  <br />
                  「特徴点を追加」で 折点 IP・単曲線 BC/EC・緩和曲線 BTC/ETC の 追加距離を 一括登録できます。
                </div>

                <div className="flex gap-1 items-center flex-wrap">
                  <button
                    onClick={() => setStationMode('sp')}
                    className={`px-2 py-1 text-xs border rounded ${
                      stationMode === 'sp' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    任意 SP
                  </button>
                  <button
                    onClick={() => setStationMode('pitch')}
                    className={`px-2 py-1 text-xs border rounded ${
                      stationMode === 'pitch' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    ピッチ割
                  </button>
                  <button
                    onClick={handleAddFeaturePoints}
                    disabled={segments.length === 0}
                    className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                    title="折点 IP / 単曲線 BC/EC / 緩和曲線 BTC/ETC を 現在の 中間点リスト に 追加"
                  >
                    <Plus className="h-3 w-3" />
                    特徴点を追加
                  </button>
                </div>

                {stationMode === 'sp' ? (
                  <div className="grid grid-cols-12 gap-2 items-end">
                    <label className="col-span-8 flex flex-col gap-0.5 text-xs">
                      <span className="text-slate-500">SP (BP からの距離 m)</span>
                      <input
                        type="number"
                        step={0.01}
                        value={stationDist}
                        onChange={(e) => setStationDist(parseFloat(e.target.value) || 0)}
                        className="px-2 py-1 border rounded text-right text-sm"
                      />
                    </label>
                    <button
                      onClick={handleAddStation}
                      disabled={segments.length === 0}
                      className="col-span-4 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      座標を計算
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-12 gap-2 items-end">
                    <label className="col-span-4 flex flex-col gap-0.5 text-xs">
                      <span className="text-slate-500">ピッチ (m)</span>
                      <input
                        type="number"
                        step={1}
                        value={stationPitch}
                        onChange={(e) => setStationPitch(parseFloat(e.target.value) || 0)}
                        className="px-2 py-1 border rounded text-right text-sm"
                      />
                    </label>
                    <label className="col-span-4 flex items-center gap-1 text-xs pb-1">
                      <input
                        type="checkbox"
                        checked={includeEp}
                        onChange={(e) => setIncludeEp(e.target.checked)}
                      />
                      EP も含める
                    </label>
                    <button
                      onClick={handleAddStation}
                      disabled={segments.length === 0}
                      className="col-span-4 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      生成
                    </button>
                  </div>
                )}

                {stations.length > 0 && (
                  <>
                    <div className="border rounded overflow-auto max-h-80">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                          <tr>
                            <th className="px-2 py-1 w-10 text-center">#</th>
                            <th className="px-2 py-1 text-left">SP</th>
                            <th className="px-2 py-1 text-right">距離 (m)</th>
                            <th className="px-2 py-1 text-right">X</th>
                            <th className="px-2 py-1 text-right">Y</th>
                            <th className="px-2 py-1 w-12 text-center">断面</th>
                            <th className="px-2 py-1 w-8"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {stations.map((s, i) => {
                            const p = pointAtDistance(segments, s.distance)
                            const isSel = s.id === selectedStationId
                            const hasOverride = s.crossSection != null
                            return (
                              <tr
                                key={s.id}
                                onClick={() =>
                                  setSelectedStationId(isSel ? null : s.id)
                                }
                                className={`border-t cursor-pointer ${
                                  isSel ? 'bg-blue-50' : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="px-2 py-1 text-center text-slate-500 text-xs">{i + 1}</td>
                                <td className="px-2 py-1 font-mono">{s.label}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{s.distance.toFixed(2)}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{p ? p.x.toFixed(3) : '-'}</td>
                                <td className="px-2 py-1 text-right tabular-nums">{p ? p.y.toFixed(3) : '-'}</td>
                                <td className="px-2 py-1 text-center">
                                  <span
                                    className={`text-[10px] px-1 py-0.5 rounded ${
                                      hasOverride
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-slate-100 text-slate-500'
                                    }`}
                                  >
                                    {hasOverride ? '個別' : '標準'}
                                  </span>
                                </td>
                                <td className="px-1 py-1 text-right">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRemoveStation(s.id)
                                    }}
                                    className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-slate-500">地図に断面を表示:</span>
                      <div className="flex gap-1">
                        {(['none', 'selected', 'all'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setOverlayMode(m)}
                            className={`px-2 py-0.5 text-[11px] border rounded ${
                              overlayMode === m
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white hover:bg-slate-50'
                            }`}
                          >
                            {m === 'none' ? 'なし' : m === 'selected' ? '選択中' : '全て'}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={handleClearStations}
                        className="ml-auto px-2 py-1 text-xs border rounded text-slate-600 hover:bg-slate-50"
                      >
                        全クリア
                      </button>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t mt-1">
                      <span className="text-[11px] text-slate-500">エクスポート:</span>
                      <button
                        onClick={handleExportSima}
                        disabled={stationVertexLists.length === 0}
                        className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                        title="各測点の断面変化点を SIMA 座標として出力"
                      >
                        SIMA
                      </button>
                      <button
                        onClick={handleExportLandXml}
                        disabled={!stationTin || stationTin.triangles.length === 0}
                        className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                        title="隣接測点の同要素番号同士を結んで TIN を作成"
                      >
                        LandXML (TIN)
                      </button>
                      {stationTin && (
                        <span className="text-[10px] text-slate-400 ml-auto">
                          {stationTin.points.length} 点 / {stationTin.triangles.length} 三角形
                        </span>
                      )}
                    </div>

                    {selectedStation && (
                      <div className="border rounded p-2 space-y-2 bg-slate-50">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-700 text-xs font-mono">
                            {selectedStation.label}
                          </span>
                          <span className="text-[10px] text-slate-500">の断面</span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              selectedStation.crossSection
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-200 text-slate-600'
                            }`}
                          >
                            {selectedStation.crossSection ? '個別設定' : '標準を継承'}
                          </span>
                          <div className="ml-auto flex gap-1">
                            {selectedStation.crossSection ? (
                              <button
                                onClick={() =>
                                  handleUpdateStationCrossSection(selectedStation.id, null)
                                }
                                className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-600 hover:bg-slate-50"
                              >
                                標準に戻す
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  handleUpdateStationCrossSection(
                                    selectedStation.id,
                                    cloneCrossSection(selected.standardCrossSection),
                                  )
                                }
                                className="px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white hover:bg-blue-700"
                              >
                                個別設定（標準を取込）
                              </button>
                            )}
                          </div>
                        </div>

                        {selectedStation.crossSection ? (
                          <>
                            <CrossSectionSideEditor
                              side="right"
                              elements={selectedStation.crossSection.right}
                              onChange={(els) =>
                                handleUpdateStationCrossSection(selectedStation.id, {
                                  ...selectedStation.crossSection!,
                                  right: els,
                                })
                              }
                            />
                            <CrossSectionSideEditor
                              side="left"
                              elements={selectedStation.crossSection.left}
                              onChange={(els) =>
                                handleUpdateStationCrossSection(selectedStation.id, {
                                  ...selectedStation.crossSection!,
                                  left: els,
                                })
                              }
                            />
                            <div className="flex justify-center pt-1">
                              <CrossSectionDiagram cs={selectedStation.crossSection} />
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[11px] text-slate-500">
                              この測点では標準断面がそのまま適用されます。「個別設定」で複製してカスタマイズできます。
                            </div>
                            <div className="flex justify-center pt-1">
                              <CrossSectionDiagram cs={selected.standardCrossSection} />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CollapsibleSection>

              {/* 縦断線形 (中間点 と 標準断面 の 間 に 配置)。
                  縦断図 の プロット は 地図の 下に 残す。ここでは 変化点 の
                  追加 / 編集 / 削除 のみ。 */}
              <CollapsibleSection title="縦断線形" storageKey="oc:section:profile">
                <div className="text-xs text-slate-500">
                  BP からの 追加距離 (m) と 計画高 (m) を 変化点 ごと に 登録します。
                  グラフ は 地図の 下 に 表示。
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAddProfile((v) => !v)}
                    className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                  >
                    {showAddProfile ? (
                      <X className="h-3 w-3" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                    {showAddProfile ? '閉じる' : '変化点追加'}
                  </button>
                  <span className="text-[11px] text-slate-400">
                    平面線形長 {totalLen.toFixed(2)} m
                  </span>
                </div>

                {showAddProfile && (
                  <div className="grid grid-cols-12 gap-2 items-end border rounded bg-slate-50 p-2">
                    <label className="col-span-5 flex flex-col gap-0.5 text-xs">
                      <span className="text-slate-500">追加距離 (m)</span>
                      <input
                        type="number"
                        step={0.1}
                        value={addProfileDist}
                        onChange={(e) => setAddProfileDist(parseFloat(e.target.value) || 0)}
                        className="px-2 py-1 border rounded text-right text-sm"
                      />
                    </label>
                    <label className="col-span-5 flex flex-col gap-0.5 text-xs">
                      <span className="text-slate-500">計画高 (m)</span>
                      <input
                        type="number"
                        step={0.001}
                        value={addProfileH}
                        onChange={(e) => setAddProfileH(parseFloat(e.target.value) || 0)}
                        className="px-2 py-1 border rounded text-right text-sm"
                      />
                    </label>
                    <button
                      onClick={() => {
                        handleAddProfile()
                        setShowAddProfile(false)
                      }}
                      className="col-span-2 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      追加
                    </button>
                    <div className="col-span-12 text-[10px] text-slate-400">
                      ※ 平面線形長 を 超えない 範囲で 設定。追加距離 0 を BP、平面線形長 相当 を EP として 登録するのが 基本。
                    </div>
                  </div>
                )}

                {sortedProfile.length > 0 ? (
                  <div className="border rounded overflow-auto max-h-56">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                        <tr>
                          <th className="px-2 py-1 w-10 text-center">#</th>
                          <th className="px-2 py-1 text-right">追加距離 (m)</th>
                          <th className="px-2 py-1 text-right">計画高 (m)</th>
                          <th className="px-2 py-1 text-right">勾配</th>
                          <th className="px-2 py-1 w-10"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedProfile.map((p, i) => {
                          const realIdx = selected.profilePoints.indexOf(p)
                          const prev = i > 0 ? sortedProfile[i - 1] : null
                          const slope = prev
                            ? (() => {
                                const dx = p.distance - prev.distance
                                const dy = p.floorHeight - prev.floorHeight
                                if (Math.abs(dx) < 1e-6) return '-'
                                if (Math.abs(dy) < 1e-9) return '水平'
                                return `1/${Math.round(Math.abs(dx / dy))}`
                              })()
                            : '-'
                          return (
                            <tr key={realIdx} className="border-t">
                              <td className="px-2 py-1 text-center text-slate-500 text-xs">
                                {i + 1}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <input
                                  type="number"
                                  step={0.1}
                                  value={p.distance}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (Number.isFinite(v))
                                      handleChangeProfile(realIdx, { distance: v })
                                  }}
                                  className="w-20 px-1 py-0.5 border rounded text-right text-sm"
                                />
                              </td>
                              <td className="px-2 py-1 text-right">
                                <input
                                  type="number"
                                  step={0.001}
                                  value={p.floorHeight}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (Number.isFinite(v))
                                      handleChangeProfile(realIdx, { floorHeight: v })
                                  }}
                                  className="w-20 px-1 py-0.5 border rounded text-right text-sm"
                                />
                              </td>
                              <td className="px-2 py-1 text-right text-slate-500 tabular-nums">
                                {slope}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <button
                                  onClick={() => handleRemoveProfile(realIdx)}
                                  className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 text-center py-2 border rounded bg-slate-50">
                    変化点がありません。「変化点追加」から登録してください。
                  </div>
                )}
              </CollapsibleSection>

              {/* 標準断面 (末尾に 配置) */}
              <CollapsibleSection title="標準断面" storageKey="oc:section:cs">
                <div className="text-[11px] text-slate-500">
                  中心 (0,0) から右・左へ要素列を順に並べます。各要素は 幅 (m) と 勾配（1:i または %） で定義。
                  外側に向かって上る場合 +、下る場合 -。種別はラベル（色分け等の将来拡張用）。
                </div>

                <CrossSectionSideEditor
                  side="right"
                  elements={selected.standardCrossSection.right}
                  onChange={(els) =>
                    updateChannel(selected.id, {
                      standardCrossSection: { ...selected.standardCrossSection, right: els },
                    })
                  }
                />

                <CrossSectionSideEditor
                  side="left"
                  elements={selected.standardCrossSection.left}
                  onChange={(els) =>
                    updateChannel(selected.id, {
                      standardCrossSection: { ...selected.standardCrossSection, left: els },
                    })
                  }
                />

                <div className="flex justify-center pt-1">
                  <CrossSectionDiagram cs={selected.standardCrossSection} />
                </div>
              </CollapsibleSection>
            </>
          )}
        </div>

        {/* 右: 地図 (上) + 縦断図 (下) */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 relative">
            <CoordinateMap
              farmId={farmId ?? null}
              showLabels
              checkedCoordIds={registeredCoordIds}
              onPointSelect={handlePickCoordFromMap}
            >
              {sampledLatLng.length >= 2 && (
                <FitBounds key={selectedId ?? 'none'} positions={sampledLatLng} />
              )}

              {sampledLatLng.length >= 2 && (
                <Polyline positions={sampledLatLng} pathOptions={{ color: '#0ea5e9', weight: 3 }} />
              )}

              {/* 中間点ごとの断面オーバーレイ */}
              {visibleStationVertices.map(({ station, vertices }) => {
                if (vertices.length < 2) return null
                const isSel = station.id === selectedStationId
                const positions: [number, number][] = vertices.map((v) => {
                  const ll = converter.toLatLng(v.x, v.y)
                  return [ll.lat, ll.lng]
                })
                const lineColor = isSel ? '#dc2626' : '#7c3aed'
                const opacity = isSel ? 1 : 0.6
                return (
                  <div key={`cs-${station.id}`}>
                    <Polyline
                      positions={positions}
                      pathOptions={{
                        color: lineColor,
                        weight: isSel ? 2.5 : 1.5,
                        opacity,
                      }}
                    />
                    {vertices.map((v, vi) => {
                      const ll = converter.toLatLng(v.x, v.y)
                      const fill =
                        v.side === 'center'
                          ? '#0ea5e9'
                          : v.side === 'right'
                          ? '#16a34a'
                          : '#f59e0b'
                      return (
                        <CircleMarker
                          key={`csv-${station.id}-${vi}`}
                          center={[ll.lat, ll.lng]}
                          radius={isSel ? 3.5 : 2.5}
                          pathOptions={{
                            color: '#fff',
                            fillColor: fill,
                            fillOpacity: opacity,
                            weight: 1,
                          }}
                        >
                          <Tooltip direction="right" offset={[4, 0]} className="!text-[10px]">
                            {station.label} / {v.label}
                            {v.side !== 'center' ? ` (${v.offset.toFixed(2)}m)` : ''}
                          </Tooltip>
                        </CircleMarker>
                      )
                    })}
                  </div>
                )
              })}
              {stations.map((s) => {
                const p = pointAtDistance(segments, s.distance)
                if (!p) return null
                const ll = converter.toLatLng(p.x, p.y)
                const isSel = s.id === selectedStationId
                const hasOverride = s.crossSection != null
                // 中間点 (SP) は 紫 で 固定。 個別断面 は 琥珀色 で 差別化。
                const fillColor = hasOverride ? '#f59e0b' : '#a78bfa'
                return (
                  <CircleMarker
                    key={s.id}
                    center={[ll.lat, ll.lng]}
                    radius={isSel ? 6 : 4}
                    eventHandlers={{
                      click: () => setSelectedStationId(isSel ? null : s.id),
                    }}
                    pathOptions={{
                      color: '#fff',
                      fillColor,
                      fillOpacity: 0.95,
                      weight: isSel ? 2 : 1.5,
                    }}
                  >
                    {/* 座標管理と 同じ 「白フチ 付き 色文字」スタイル
                        (point-label-tooltip class で 背景・枠 を 透明化)。
                        常時表示 で 測点名 が いつでも 見える。 */}
                    <Tooltip
                      permanent
                      direction="bottom"
                      offset={[0, 6]}
                      className="point-label-tooltip"
                    >
                      <span
                        style={{
                          color: fillColor,
                          textShadow:
                            '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                        }}
                      >
                        {s.label}
                        {hasOverride ? ' (個別)' : ''}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </CoordinateMap>
          </div>

          {/* 縦断図 (地図の 下、プロットのみ)。編集 UI は 左サイドバー 「縦断線形」に */}
          {selected && (
            <div className="shrink-0 border-t bg-white p-2 flex items-center gap-3">
              <span className="font-semibold text-slate-700 text-sm">縦断図</span>
              <span className="text-[11px] text-slate-500">
                変化点 の 追加 / 編集 は 左サイドバー 「縦断線形」から
              </span>
              <div className="ml-auto">
                <ProfileChart points={selected.profilePoints} totalLen={totalLen} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
