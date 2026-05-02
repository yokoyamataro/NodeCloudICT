// 小水路（明渠）— 線形登録ページ
//
// - 圃場ごとに複数の小水路を登録可能
// - 各小水路は線形（BP→IP→EP、IP は角 or 単曲線 R）と断面（W, 1:i）で定義
// - 座標管理の点を参照する
// - 地図で線形（直線 + 曲線）をプレビュー

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Plus, Trash2, ArrowUp, ArrowDown, Waves } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useOpenChannelStore, type AlignmentPoint, type AlignmentPointKind, type ProfilePoint } from '@/stores/openChannelStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { sampleAlignment, alignmentLength, type AlignmentVertex } from '@/lib/openChannel/alignment'

function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length < 2) return
    const bounds = L.latLngBounds(positions)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 })
  }, [positions, map])
  return null
}

// 断面形状の図（流れ方向を見た形）
function CrossSectionDiagram({
  W, slopeRatio, bankHeight,
}: { W: number; slopeRatio: number; bankHeight: number | null }) {
  if (!Number.isFinite(W) || W <= 0 || !Number.isFinite(slopeRatio) || slopeRatio <= 0) {
    return <div className="text-xs text-slate-400 px-2 py-1">寸法が不正です</div>
  }
  const i = slopeRatio
  // 法面深さが未指定なら表示用に床幅相当を仮定
  const h = bankHeight != null && bankHeight > 0 ? bankHeight : Math.max(W * 0.6, 0.5)
  const sw = h * i
  const total = W + sw * 2

  const widthPx = 280
  const heightPx = 120
  const padding = { top: 16, right: 30, bottom: 28, left: 30 }
  const innerW = widthPx - padding.left - padding.right
  const innerH = heightPx - padding.top - padding.bottom
  const scaleX = innerW / total
  const scaleY = innerH / h
  const scale = Math.min(scaleX, scaleY)

  const cx = padding.left + innerW / 2 // 中心の SVG x
  const baseY = padding.top + innerH // 床面の SVG y

  const tx = (x: number) => cx + x * scale
  const ty = (y: number) => baseY - y * scale

  return (
    <svg width={widthPx} height={heightPx} className="border rounded bg-slate-50">
      {/* 法肩の参考水平線 */}
      <line x1={padding.left} y1={ty(h)} x2={widthPx - padding.right} y2={ty(h)}
        stroke="#cbd5e1" strokeDasharray="2,3" strokeWidth={1} />
      {/* 中心線 */}
      <line x1={tx(0)} y1={ty(-h * 0.05)} x2={tx(0)} y2={ty(h * 1.05)}
        stroke="#cbd5e1" strokeDasharray="3,3" strokeWidth={1} />

      {/* 断面トラペゾイド */}
      <polygon
        points={[
          `${tx(-total / 2)},${ty(h)}`,
          `${tx(-W / 2)},${ty(0)}`,
          `${tx(W / 2)},${ty(0)}`,
          `${tx(total / 2)},${ty(h)}`,
        ].join(' ')}
        fill="rgba(14,165,233,0.15)"
        stroke="#0ea5e9"
        strokeWidth={1.5}
      />

      {/* 床面寸法 */}
      <line x1={tx(-W / 2)} y1={baseY + 8} x2={tx(W / 2)} y2={baseY + 8}
        stroke="#0ea5e9" strokeWidth={1} markerStart="url(#arrL)" markerEnd="url(#arrR)" />
      <text x={cx} y={baseY + 20} textAnchor="middle" fontSize={10} fill="#0ea5e9" fontWeight="bold">
        W = {W.toFixed(2)} m
      </text>

      {/* 斜面勾配ラベル */}
      <text x={tx(W / 2 + sw * 0.55)} y={ty(h * 0.5)} textAnchor="middle" fontSize={10} fill="#475569">
        1:{i}
      </text>
      <text x={tx(-W / 2 - sw * 0.55)} y={ty(h * 0.5)} textAnchor="middle" fontSize={10} fill="#475569">
        1:{i}
      </text>

      {/* 高さ寸法（右側） */}
      <text x={widthPx - padding.right + 4} y={ty(h / 2)} textAnchor="start" fontSize={9} fill="#64748b">
        {bankHeight != null ? `H=${bankHeight.toFixed(2)}` : `(H 仮 ${h.toFixed(2)})`}
      </text>

      <defs>
        <marker id="arrL" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
          <path d="M6,0 L0,3 L6,6 z" fill="#0ea5e9" />
        </marker>
        <marker id="arrR" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="#0ea5e9" />
        </marker>
      </defs>
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

  const sampledXY = useMemo(() => sampleAlignment(alignmentXY, 24), [alignmentXY])
  const totalLen = useMemo(() => alignmentLength(sampledXY), [sampledXY])

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

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="小水路 線形登録" subtitle="小水路（明渠） / 線形 + 断面" />
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">圃場を選択してください</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="小水路 線形登録" subtitle="小水路（明渠） / 線形 + 断面" />

      <div className="flex-1 flex overflow-hidden">
        {/* 左: 一覧 + 編集 */}
        <div className="w-[440px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
          {/* 一覧 + 追加 */}
          <section className="bg-white rounded-lg border p-3">
            <div className="flex items-center gap-2 mb-2">
              <Waves className="h-4 w-4 text-slate-600" />
              <h2 className="font-semibold text-slate-800 text-sm">小水路一覧</h2>
              <button
                onClick={() => farmId && addChannel(farmId)}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
              >
                <Plus className="h-3 w-3" />
                追加
              </button>
            </div>
            {channels.length === 0 ? (
              <div className="text-xs text-slate-500">まだ登録された小水路がありません</div>
            ) : (
              <div className="flex flex-col gap-1">
                {channels.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`text-left px-2 py-1 text-xs rounded border ${
                      c.id === selectedId ? 'bg-blue-50 border-blue-400' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    {c.name}
                    <span className="ml-2 text-slate-400">
                      {c.alignmentPoints.length} 点 / W={c.floorWidth.toFixed(2)}m, 1:{c.slopeRatio}
                    </span>
                  </button>
                ))}
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
                  この小水路を削除
                </button>
              </section>

              {/* 断面 */}
              <section className="bg-white rounded-lg border p-3 space-y-2">
                <h3 className="font-semibold text-slate-800 text-sm">断面</h3>
                <div className="grid grid-cols-3 gap-2">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-slate-500">床幅 W (m)</span>
                    <input
                      type="number"
                      step={0.05}
                      value={selected.floorWidth}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (Number.isFinite(v) && v >= 0) updateChannel(selected.id, { floorWidth: v })
                      }}
                      className="px-2 py-1 border rounded text-right text-sm"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-slate-500">斜面勾配 1:i</span>
                    <input
                      type="number"
                      step={0.1}
                      value={selected.slopeRatio}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (Number.isFinite(v) && v > 0) updateChannel(selected.id, { slopeRatio: v })
                      }}
                      className="px-2 py-1 border rounded text-right text-sm"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-slate-500">法面深さ (m)</span>
                    <input
                      type="number"
                      step={0.1}
                      value={selected.bankHeight ?? ''}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        updateChannel(selected.id, { bankHeight: Number.isFinite(v) ? v : null })
                      }}
                      placeholder="-"
                      className="px-2 py-1 border rounded text-right text-sm"
                    />
                  </label>
                </div>
                <div className="text-[11px] text-slate-500">
                  中心 ±{(selected.floorWidth / 2).toFixed(2)} m が床、外側 sw m 進むと {selected.slopeRatio > 0 ? `${(1 / selected.slopeRatio).toFixed(3)}` : '-'} × sw m 高くなる
                </div>
                <div className="flex justify-center pt-1">
                  <CrossSectionDiagram
                    W={selected.floorWidth}
                    slopeRatio={selected.slopeRatio}
                    bankHeight={selected.bankHeight}
                  />
                </div>
              </section>

              {/* 線形点 */}
              <section className="bg-white rounded-lg border p-3 space-y-2">
                <h3 className="font-semibold text-slate-800 text-sm">線形点（BP → IP → EP）</h3>
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
              </section>

              {/* 縦断線形 */}
              <section className="bg-white rounded-lg border p-3 space-y-2">
                <h3 className="font-semibold text-slate-800 text-sm">縦断線形</h3>
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
              </section>

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
