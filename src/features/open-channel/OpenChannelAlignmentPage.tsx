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
import { useOpenChannelStore, type AlignmentPoint, type AlignmentPointKind } from '@/stores/openChannelStore'
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
