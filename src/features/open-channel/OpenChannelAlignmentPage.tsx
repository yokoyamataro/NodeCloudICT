// 線形物（水路・道路）— 線形登録ページ
//
// - 圃場ごとに複数の線形物を登録可能
// - 各線形物は平面線形（BP→IP→EP、IP は角 or 単曲線 R）+ 縦断 + 標準断面で定義
// - 標準断面は中心から右/左に並ぶ要素列（幅・勾配[1:i または %]）
// - 座標管理の点を参照する
// - 地図で線形（直線 + 曲線）をプレビュー

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Plus, Trash2, ArrowUp, ArrowDown, Waves, ChevronRight, ChevronDown } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
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
  buildCrossSectionPath,
  formatSlope,
} from '@/stores/openChannelStore'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  sampleAlignment,
  alignmentTotalLength,
  buildSegments,
  pointAtDistance,
  getCurveMarkers,
  getCornerIpStations,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'

/** タイトルのみで折りたたみ可能なセクション（開閉状態は localStorage に記憶可）。 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  storageKey,
  children,
}: {
  title: string
  defaultOpen?: boolean
  storageKey?: string
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

function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length < 2) return
    const bounds = L.latLngBounds(positions)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 })
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
    cx += e.width
    cy += e.width * (e.slopeUnit === 'percent' ? e.slopeValue / 100 : (Math.abs(e.slopeValue) < 1e-9 ? 0 : Math.sign(e.slopeValue) / Math.abs(e.slopeValue)))
    segs.push({ from, to: { x: cx, y: cy }, e })
  }
  cx = 0
  cy = 0
  for (const e of cs.left) {
    const from = { x: cx, y: cy }
    cx += -e.width
    cy += e.width * (e.slopeUnit === 'percent' ? e.slopeValue / 100 : (Math.abs(e.slopeValue) < 1e-9 ? 0 : Math.sign(e.slopeValue) / Math.abs(e.slopeValue)))
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

// 縦断図（追加距離 vs 床高）
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
      <text x={5} y={padding.top - 2} fontSize={9} fill="#64748b">床高 (m)</text>
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
              <th className="px-1 py-1 text-right w-14">勾配</th>
              <th className="px-1 py-1 text-center w-14">単位</th>
              <th className="px-1 py-1 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {elements.map((el, i) => (
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
                  <input
                    type="number"
                    step={0.05}
                    value={el.width}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (Number.isFinite(v) && v >= 0) updateAt(i, { width: v })
                    }}
                    className="w-14 px-1 py-0.5 border rounded text-right text-xs"
                  />
                </td>
                <td className="px-1 py-1 text-right">
                  <input
                    type="number"
                    step={el.slopeUnit === 'percent' ? 0.1 : 0.05}
                    value={el.slopeValue}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (Number.isFinite(v)) updateAt(i, { slopeValue: v })
                    }}
                    className="w-14 px-1 py-0.5 border rounded text-right text-xs"
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
            ))}
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

  // 線形点を解決して XY 列に変換
  const alignmentXY = useMemo<AlignmentVertex[]>(() => {
    if (!selected) return []
    const out: AlignmentVertex[] = []
    for (const p of selected.alignmentPoints) {
      const c = coordinates.find((cc) => cc.id === p.coordId)
      if (!c) continue
      out.push({ x: c.x, y: c.y, kind: p.kind, radius: p.radius })
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

  // 制御点（IP/BP/EP）の lat/lng
  const controlMarkers = useMemo(() => {
    if (!selected) return []
    return selected.alignmentPoints
      .map((p, i) => {
        const c = coordinates.find((cc) => cc.id === p.coordId)
        if (!c || c.lat == null || c.lng == null) return null
        return { idx: i, point: p, lat: c.lat, lng: c.lng, name: c.pointNumber }
      })
      .filter((x): x is { idx: number; point: AlignmentPoint; lat: number; lng: number; name: string } => x !== null)
  }, [selected, coordinates])

  // 線形点の追加: 座標と種別を選択
  const [addCoordId, setAddCoordId] = useState<string>('')
  const [addKind, setAddKind] = useState<AlignmentPointKind>('ip')
  const [addRadius, setAddRadius] = useState<number>(0)

  const handleAddPoint = () => {
    if (!selected || !addCoordId) return
    const next: AlignmentPoint[] = [
      ...selected.alignmentPoints,
      { coordId: addCoordId, kind: addKind, radius: addKind === 'ip' && addRadius > 0 ? addRadius : undefined },
    ]
    updateChannel(selected.id, { alignmentPoints: next })
    setAddCoordId('')
  }

  const handleMovePoint = (idx: number, dir: -1 | 1) => {
    if (!selected) return
    const arr = selected.alignmentPoints.slice()
    const target = idx + dir
    if (target < 0 || target >= arr.length) return
    const tmp = arr[idx]
    arr[idx] = arr[target]
    arr[target] = tmp
    updateChannel(selected.id, { alignmentPoints: arr })
  }

  const handleRemovePoint = (idx: number) => {
    if (!selected) return
    const arr = selected.alignmentPoints.filter((_, i) => i !== idx)
    updateChannel(selected.id, { alignmentPoints: arr })
  }

  const handleChangePoint = (idx: number, patch: Partial<AlignmentPoint>) => {
    if (!selected) return
    const arr = selected.alignmentPoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    updateChannel(selected.id, { alignmentPoints: arr })
  }

  // 縦断線形（profile）操作
  const [addProfileDist, setAddProfileDist] = useState<number>(0)
  const [addProfileH, setAddProfileH] = useState<number>(0)

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
  const formatIp = (d: number) => `IP${d.toFixed(2)}`

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
      for (const m of getCurveMarkers(segments)) {
        push(m.kind === 'bc' ? formatBc(m.distance) : formatEc(m.distance), m.distance)
      }
      for (const m of getCornerIpStations(alignmentXY)) {
        push(formatIp(m.distance), m.distance)
      }

      // 距離でソート + 同距離の SP は IP/BC/EC を優先して重複排除
      out.sort((a, b) => a.distance - b.distance)
      const merged: StationRow[] = []
      const isMarker = (label: string) =>
        label.startsWith('BC') || label.startsWith('EC') || label.startsWith('IP')
      for (const s of out) {
        const prev = merged[merged.length - 1]
        if (prev && Math.abs(prev.distance - s.distance) < 5e-3) {
          if (isMarker(s.label) && !isMarker(prev.label)) merged[merged.length - 1] = s
          continue
        }
        merged.push(s)
      }

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

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 標準断面" />
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">圃場を選択してください</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 標準断面" />

      <div className="flex-1 flex overflow-hidden">
        {/* 左: 一覧 + 編集 */}
        <div className="w-[480px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
          {/* 一覧 + 追加 */}
          <section className="bg-white rounded-lg border p-3">
            <div className="flex items-center gap-2 mb-2">
              <Waves className="h-4 w-4 text-slate-600" />
              <h2 className="font-semibold text-slate-800 text-sm">線形物一覧</h2>
              <button
                onClick={() => farmId && addChannel(farmId)}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
              >
                <Plus className="h-3 w-3" />
                追加
              </button>
            </div>
            {channels.length === 0 ? (
              <div className="text-xs text-slate-500">まだ登録された線形物がありません</div>
            ) : (
              <div className="flex flex-col gap-1">
                {channels.map((c) => {
                  const totalEls = c.standardCrossSection.right.length + c.standardCrossSection.left.length
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={`text-left px-2 py-1 text-xs rounded border ${
                        c.id === selectedId ? 'bg-blue-50 border-blue-400' : 'bg-white hover:bg-slate-50'
                      }`}
                    >
                      {c.name}
                      <span className="ml-2 text-slate-400">
                        {c.alignmentPoints.length} 点 / 断面 {totalEls} 要素
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {selected && (
            <>
              {/* 識別 + 削除 */}
              <section className="bg-white rounded-lg border p-3 space-y-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-slate-500">名称</span>
                  <input
                    type="text"
                    value={selected.name}
                    onChange={(e) => updateChannel(selected.id, { name: e.target.value })}
                    className="px-2 py-1 border rounded text-sm"
                  />
                </label>
                <button
                  onClick={() => {
                    if (window.confirm(`「${selected.name}」を削除しますか？`)) deleteChannel(selected.id)
                  }}
                  className="flex items-center gap-1 px-2 py-1 text-xs border rounded text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-3 w-3" />
                  この線形物を削除
                </button>
              </section>

              {/* 標準断面 */}
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

              {/* 線形点 */}
              <CollapsibleSection title="線形点（BP → IP → EP）" storageKey="oc:section:alignment">
                <div className="text-[11px] text-slate-500">座標管理の点を順序付きで参照します</div>

                {selected.alignmentPoints.length > 0 && (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-1 py-1 w-8 text-center">#</th>
                          <th className="px-1 py-1 text-left">点名</th>
                          <th className="px-1 py-1 w-14">種別</th>
                          <th className="px-1 py-1 w-16 text-right">R (m)</th>
                          <th className="px-1 py-1 w-12"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.alignmentPoints.map((p, i) => {
                          const c = coordinates.find((cc) => cc.id === p.coordId)
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-1 py-1 text-center text-slate-500">{i + 1}</td>
                              <td className="px-1 py-1">{c?.pointNumber ?? '？'}</td>
                              <td className="px-1 py-1">
                                <select
                                  value={p.kind}
                                  onChange={(e) => handleChangePoint(i, { kind: e.target.value as AlignmentPointKind })}
                                  className="px-1 py-0.5 border rounded text-xs"
                                >
                                  <option value="bp">BP</option>
                                  <option value="ip">IP</option>
                                  <option value="ep">EP</option>
                                </select>
                              </td>
                              <td className="px-1 py-1 text-right">
                                {p.kind === 'ip' ? (
                                  <input
                                    type="number"
                                    step={0.5}
                                    value={p.radius ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, { radius: Number.isFinite(v) && v > 0 ? v : undefined })
                                    }}
                                    className="w-14 px-1 py-0.5 border rounded text-right text-xs"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="px-1 py-1 text-right">
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
                )}

                {/* 追加フォーム */}
                <div className="grid grid-cols-12 gap-1 items-end">
                  <select
                    value={addCoordId}
                    onChange={(e) => setAddCoordId(e.target.value)}
                    className="col-span-6 px-1 py-1 border rounded text-xs"
                  >
                    <option value="">座標を選択…</option>
                    {(coordinates as CoordinateRow[]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pointNumber}
                      </option>
                    ))}
                  </select>
                  <select
                    value={addKind}
                    onChange={(e) => setAddKind(e.target.value as AlignmentPointKind)}
                    className="col-span-2 px-1 py-1 border rounded text-xs"
                  >
                    <option value="bp">BP</option>
                    <option value="ip">IP</option>
                    <option value="ep">EP</option>
                  </select>
                  <input
                    type="number"
                    step={0.5}
                    value={addKind === 'ip' ? addRadius : 0}
                    onChange={(e) => setAddRadius(parseFloat(e.target.value) || 0)}
                    disabled={addKind !== 'ip'}
                    placeholder="R"
                    className="col-span-2 px-1 py-1 border rounded text-xs text-right disabled:bg-slate-100"
                  />
                  <button
                    onClick={handleAddPoint}
                    disabled={!addCoordId}
                    className="col-span-2 flex items-center justify-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    追加
                  </button>
                </div>
              </CollapsibleSection>

              {/* 縦断線形 */}
              <CollapsibleSection title="縦断線形" storageKey="oc:section:profile">
                <div className="text-[11px] text-slate-500">
                  BP からの追加距離 (m) と床高 (m) を変化点ごとに登録します
                </div>

                {sortedProfile.length > 0 && (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-1 py-1 w-8 text-center">#</th>
                          <th className="px-1 py-1 text-right">追加距離 (m)</th>
                          <th className="px-1 py-1 text-right">床高 (m)</th>
                          <th className="px-1 py-1 text-right">勾配</th>
                          <th className="px-1 py-1 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedProfile.map((p, i) => {
                          // 元の配列インデックス（ソート前）
                          const origIdx = selected.profilePoints.findIndex(
                            (q) => q === selected.profilePoints[selected.profilePoints.indexOf(p)],
                          )
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
                            <tr key={`${realIdx}-${origIdx}`} className="border-t">
                              <td className="px-1 py-1 text-center text-slate-500">{i + 1}</td>
                              <td className="px-1 py-1 text-right">
                                <input
                                  type="number"
                                  step={0.1}
                                  value={p.distance}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (Number.isFinite(v)) handleChangeProfile(realIdx, { distance: v })
                                  }}
                                  className="w-20 px-1 py-0.5 border rounded text-right text-xs"
                                />
                              </td>
                              <td className="px-1 py-1 text-right">
                                <input
                                  type="number"
                                  step={0.001}
                                  value={p.floorHeight}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (Number.isFinite(v)) handleChangeProfile(realIdx, { floorHeight: v })
                                  }}
                                  className="w-20 px-1 py-0.5 border rounded text-right text-xs"
                                />
                              </td>
                              <td className="px-1 py-1 text-right text-slate-500 tabular-nums">{slope}</td>
                              <td className="px-1 py-1 text-right">
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
                )}

                {/* 追加 */}
                <div className="grid grid-cols-12 gap-1 items-end">
                  <label className="col-span-5 flex flex-col gap-0.5 text-[11px]">
                    <span className="text-slate-500">追加距離 (m)</span>
                    <input
                      type="number"
                      step={0.1}
                      value={addProfileDist}
                      onChange={(e) => setAddProfileDist(parseFloat(e.target.value) || 0)}
                      className="px-1 py-1 border rounded text-right text-xs"
                    />
                  </label>
                  <label className="col-span-5 flex flex-col gap-0.5 text-[11px]">
                    <span className="text-slate-500">床高 (m)</span>
                    <input
                      type="number"
                      step={0.001}
                      value={addProfileH}
                      onChange={(e) => setAddProfileH(parseFloat(e.target.value) || 0)}
                      className="px-1 py-1 border rounded text-right text-xs"
                    />
                  </label>
                  <button
                    onClick={handleAddProfile}
                    className="col-span-2 flex items-center justify-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    <Plus className="h-3 w-3" />
                    追加
                  </button>
                </div>
                <div className="text-[11px] text-slate-400">
                  ※ 平面線形長 ({totalLen.toFixed(2)} m) を超えない範囲で設定。
                  追加距離 0 を BP、平面線形長相当を EP として登録するのが基本。
                </div>
                <div className="flex justify-center pt-1">
                  <ProfileChart points={selected.profilePoints} totalLen={totalLen} />
                </div>
              </CollapsibleSection>

              {/* 中間点計算 */}
              <CollapsibleSection title="中間点計算" storageKey="oc:section:stations">
                <div className="text-[11px] text-slate-500">
                  線形上の任意位置の座標を算出します。BP からの距離 (m) を SP 値として扱います。
                  ピッチ割では BP/EP は SP0.00 / SP{`{`}全長{`}`}.00、円弧の起終点は BC{`{`}距離{`}`}.00 / EC{`{`}距離{`}`}.00 として表示。
                </div>

                <div className="flex gap-1">
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
                </div>

                {stationMode === 'sp' ? (
                  <div className="grid grid-cols-12 gap-1 items-end">
                    <label className="col-span-7 flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-500">SP (BP からの距離 m)</span>
                      <input
                        type="number"
                        step={0.01}
                        value={stationDist}
                        onChange={(e) => setStationDist(parseFloat(e.target.value) || 0)}
                        className="px-1 py-1 border rounded text-right text-xs"
                      />
                    </label>
                    <button
                      onClick={handleAddStation}
                      disabled={segments.length === 0}
                      className="col-span-5 flex items-center justify-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" />
                      座標を計算
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-12 gap-1 items-end">
                    <label className="col-span-4 flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-500">ピッチ (m)</span>
                      <input
                        type="number"
                        step={1}
                        value={stationPitch}
                        onChange={(e) => setStationPitch(parseFloat(e.target.value) || 0)}
                        className="px-1 py-1 border rounded text-right text-xs"
                      />
                    </label>
                    <label className="col-span-4 flex items-center gap-1 text-[11px] pb-1">
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
                      className="col-span-4 flex items-center justify-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" />
                      生成
                    </button>
                  </div>
                )}

                {stations.length > 0 && (
                  <>
                    <div className="border rounded overflow-auto max-h-64">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0">
                          <tr>
                            <th className="px-1 py-1 w-8 text-center">#</th>
                            <th className="px-1 py-1 text-left">SP</th>
                            <th className="px-1 py-1 text-right">距離(m)</th>
                            <th className="px-1 py-1 text-right">X</th>
                            <th className="px-1 py-1 text-right">Y</th>
                            <th className="px-1 py-1 w-8 text-center">断面</th>
                            <th className="px-1 py-1 w-8"></th>
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
                                <td className="px-1 py-1 text-center text-slate-500">{i + 1}</td>
                                <td className="px-1 py-1 font-mono">{s.label}</td>
                                <td className="px-1 py-1 text-right tabular-nums">{s.distance.toFixed(2)}</td>
                                <td className="px-1 py-1 text-right tabular-nums">{p ? p.x.toFixed(3) : '-'}</td>
                                <td className="px-1 py-1 text-right tabular-nums">{p ? p.y.toFixed(3) : '-'}</td>
                                <td className="px-1 py-1 text-center">
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
                    <div className="flex justify-end">
                      <button
                        onClick={handleClearStations}
                        className="px-2 py-1 text-xs border rounded text-slate-600 hover:bg-slate-50"
                      >
                        全クリア
                      </button>
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

              <section className="bg-white rounded-lg border p-3 text-xs text-slate-600 space-y-1">
                <div>
                  <span className="text-slate-500">線形長: </span>
                  <span className="font-mono tabular-nums">{totalLen.toFixed(2)} m</span>
                </div>
                <div className="text-[11px] text-slate-400">
                  ※ 直線部分 + 単曲線 R 補間で算出（クロソイド非対応）
                </div>
              </section>
            </>
          )}
        </div>

        {/* 右: 地図 */}
        <div className="flex-1 flex flex-col">
          <div className="flex-1 relative">
            <MapContainer center={[43.06, 141.35]} zoom={13} maxZoom={22} className="h-full w-full">
              <TileLayer
                attribution='&copy; 国土地理院'
                url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
                maxZoom={22}
                maxNativeZoom={18}
              />
              {sampledLatLng.length >= 2 && <FitBounds positions={sampledLatLng} />}

              {sampledLatLng.length >= 2 && (
                <Polyline positions={sampledLatLng} pathOptions={{ color: '#0ea5e9', weight: 3 }} />
              )}
              {stations.map((s) => {
                const p = pointAtDistance(segments, s.distance)
                if (!p) return null
                const ll = converter.toLatLng(p.x, p.y)
                const isSel = s.id === selectedStationId
                const hasOverride = s.crossSection != null
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
                      fillColor: hasOverride ? '#f59e0b' : '#a78bfa',
                      fillOpacity: 0.95,
                      weight: isSel ? 2 : 1.5,
                    }}
                  >
                    <Tooltip direction="bottom" offset={[0, 4]} className="!text-[10px]">
                      {s.label}
                      {hasOverride ? ' (個別)' : ''}
                    </Tooltip>
                  </CircleMarker>
                )
              })}
              {controlMarkers.map((m) => {
                const color = m.point.kind === 'bp' ? '#16a34a' : m.point.kind === 'ep' ? '#dc2626' : '#f59e0b'
                return (
                  <CircleMarker
                    key={m.idx}
                    center={[m.lat, m.lng]}
                    radius={6}
                    pathOptions={{ color: '#fff', fillColor: color, fillOpacity: 1, weight: 2 }}
                  >
                    <Tooltip permanent direction="top" offset={[0, -8]} className="!text-[10px]">
                      {m.point.kind.toUpperCase()} {m.name}
                      {m.point.kind === 'ip' && m.point.radius ? ` R=${m.point.radius}` : ''}
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </MapContainer>
          </div>
        </div>
      </div>
    </div>
  )
}
