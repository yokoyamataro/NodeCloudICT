// 稼働中車両を地図上に描くビュー (単独ページ用ではなく組込コンポーネント)。
//
// - 組織内の active assignment × 最新位置をマーカー表示
// - Supabase Realtime で mobility_positions INSERT を購読
// - onMarkerClick で親コンポーネントに車両クリックを通知

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, TileLayer, Polyline, useMap } from 'react-leaflet'
import { VehicleMarker } from '@/features/mobility/VehicleMarker'
import L, { type LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, RotateCcw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useMobilityStore } from '@/stores/mobilityStore'
import { bearingLabel, bearingDeg, haversineMeters } from '@/lib/geoDistance'
import type { MobilityPosition } from '@/types/database'

const COLOR_ACTIVE = '#10b981'

// assignment_id からハッシュベースで安定した HSL 色を生成 (車両ごとに色分け)
function colorForAssignment(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return `hsl(${hue}, 70%, 50%)`
}

// 目的地ピン (吹き出しに名称)。オレンジで統一。
// iconAnchor をボックス下端中央にすることで pin の tip が緯度経度に刺さる。
const DEST_ICON_W = 220
const DEST_ICON_TAIL_H = 8
const DEST_ICON_BODY_H = 22
const DEST_ICON_H = DEST_ICON_BODY_H + DEST_ICON_TAIL_H

function buildDestinationIcon(name: string): L.DivIcon {
  const safe = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const html = `
    <div style="width:${DEST_ICON_W}px;height:${DEST_ICON_H}px;overflow:visible;pointer-events:none;text-align:center;">
      <div style="display:inline-block;background:#f59e0b;color:#111827;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.5);max-width:${DEST_ICON_W - 8}px;overflow:hidden;text-overflow:ellipsis;line-height:${DEST_ICON_BODY_H - 6}px;">🚩 ${safe}</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:${DEST_ICON_TAIL_H}px solid #f59e0b;margin:0 auto;"></div>
    </div>`
  return L.divIcon({
    className: 'mobility-destination-icon',
    html,
    iconSize: [DEST_ICON_W, DEST_ICON_H],
    iconAnchor: [DEST_ICON_W / 2, DEST_ICON_H],
  })
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`
}

function AutoFitBounds({
  positions,
}: {
  positions: Array<{ lat: number; lon: number }>
}) {
  const map = useMap()
  const didFitRef = useRef(false)
  useEffect(() => {
    if (didFitRef.current || positions.length === 0) return
    const bounds: LatLngBoundsExpression = positions.map(
      (p) => [p.lat, p.lon] as [number, number],
    )
    if (positions.length === 1) {
      map.setView(bounds[0] as [number, number], 15, { animate: false })
    } else {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: false })
    }
    didFitRef.current = true
  }, [positions, map])
  return null
}

interface FleetMapViewProps {
  organizationId: string
  /** マーカー押下で車両詳細へ飛ばす等の親フック */
  onSelectVehicle?: (vehicleId: string) => void
  /**
   * 稼働中割当の軌跡に加えて、追加で地図に描画したい assignment id 群。
   * 通常は「サイドバーで運行履歴のチェックボックスを ON にしたもの」。
   * 稼働中割当と重複しても構わない (Map で dedup される)。
   */
  extraTrackAssignmentIds?: string[]
}

export function FleetMapView({
  organizationId,
  onSelectVehicle,
  extraTrackAssignmentIds,
}: FleetMapViewProps) {
  const {
    vehicles,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    fetchLatestPositions,
    fetchPositionsForAssignments,
  } = useMobilityStore()

  const [latestPositions, setLatestPositions] = useState<
    Map<string, MobilityPosition>
  >(new Map())
  // 稼働中車両の走行軌跡 (assignment_id → positions 昇順)
  const [trackPositions, setTrackPositions] = useState<
    Map<string, MobilityPosition[]>
  >(new Map())
  // サイドバーから明示的に「地図に出したい」と指示された assignment の軌跡
  const [extraTracks, setExtraTracks] = useState<
    Map<string, MobilityPosition[]>
  >(new Map())
  const [loading, setLoading] = useState(true)

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      await fetchVehicles(organizationId)
      await fetchActiveAssignments(organizationId)
      const ids = Array.from(useMobilityStore.getState().activeAssignments.values()).map(
        (a) => a.id,
      )
      const [positions, tracks] = await Promise.all([
        fetchLatestPositions(ids),
        fetchPositionsForAssignments(ids, 500),
      ])
      setLatestPositions(positions)
      setTrackPositions(tracks)
    } finally {
      setLoading(false)
    }
  }, [
    organizationId,
    fetchVehicles,
    fetchActiveAssignments,
    fetchLatestPositions,
    fetchPositionsForAssignments,
  ])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    const channel = supabase
      .channel(`mobility-positions-fleet-${organizationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mobility_positions' },
        (payload) => {
          const row = payload.new as MobilityPosition | undefined
          if (!row) return
          const active = useMobilityStore.getState().activeAssignments
          const isOurs = Array.from(active.values()).some(
            (a) => a.id === row.assignment_id,
          )
          if (!isOurs) return
          setLatestPositions((prev) => {
            const next = new Map(prev)
            const existing = next.get(row.assignment_id)
            if (
              !existing ||
              new Date(row.recorded_at).getTime() >
                new Date(existing.recorded_at).getTime()
            ) {
              next.set(row.assignment_id, row)
            }
            return next
          })
          // 軌跡にも追加 (末尾に append)
          setTrackPositions((prev) => {
            const next = new Map(prev)
            const arr = next.get(row.assignment_id)
            if (arr) {
              // 同 id を重複追加しないよう最終要素と比較
              if (!arr.length || arr[arr.length - 1].id !== row.id) {
                next.set(row.assignment_id, [...arr, row])
              }
            } else {
              next.set(row.assignment_id, [row])
            }
            return next
          })
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [organizationId])

  // サイドバーの履歴チェックで指定された assignment の位置ログを都度取得。
  // 差分だけ fetch すれば十分だが、件数は多くて数十件なので毎回まとめて取り直す。
  useEffect(() => {
    const ids = extraTrackAssignmentIds ?? []
    if (ids.length === 0) {
      setExtraTracks(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const map = await fetchPositionsForAssignments(ids, 1000)
      if (!cancelled) setExtraTracks(map)
    })()
    return () => {
      cancelled = true
    }
  }, [extraTrackAssignmentIds, fetchPositionsForAssignments])

  // vehicle_assignments の UPDATE を購読して、ドライバーが行き先を変えたら
  // 管理画面に即反映させる。start/end (INSERT / ended_at) はこの購読では
  // 拾わないので、その辺の変化は fetchActiveAssignments に依存 (再取得ボタン)。
  useEffect(() => {
    const channel = supabase
      .channel(`vehicle-assignments-fleet-${organizationId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'vehicle_assignments' },
        () => {
          // 差分適用は destination_point の enrich が必要で面倒なので、
          // 割当一覧を丸ごと再取得 (件数はせいぜい 数十件)
          void useMobilityStore.getState().fetchActiveAssignments(organizationId)
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [organizationId])

  const markers = useMemo(() => {
    const rows: {
      assignmentId: string
      vehicleId: string
      lat: number
      lon: number
      vehicleName: string
      driverName: string
      recordedAt: string
      accuracy_m: number | null
      speed_kmh: number | null
      heading_deg: number | null
      destination: {
        id: string
        name: string
        lat: number
        lon: number
      } | null
    }[] = []
    for (const [assignmentId, pos] of latestPositions) {
      const assignment = Array.from(activeAssignments.values()).find(
        (a) => a.id === assignmentId,
      )
      if (!assignment) continue
      const vehicle = vehicles.find((v) => v.id === assignment.vehicle_id)
      const dp = assignment.destination_point
      rows.push({
        assignmentId,
        vehicleId: assignment.vehicle_id,
        lat: pos.lat,
        lon: pos.lon,
        vehicleName: vehicle?.name ?? '(不明車両)',
        driverName: assignment.driver_name ?? '(名前未設定)',
        recordedAt: pos.recorded_at,
        accuracy_m: pos.accuracy_m,
        speed_kmh: pos.speed_kmh,
        heading_deg: pos.heading_deg,
        destination: dp
          ? { id: dp.id, name: dp.name, lat: dp.lat, lon: dp.lon }
          : null,
      })
    }
    return rows
  }, [latestPositions, activeAssignments, vehicles])

  const positionsForBounds = useMemo(() => {
    const rows: { lat: number; lon: number }[] = []
    for (const p of latestPositions.values()) rows.push({ lat: p.lat, lon: p.lon })
    // 目的地も画面に収める
    for (const m of markers) {
      if (m.destination) rows.push({ lat: m.destination.lat, lon: m.destination.lon })
    }
    // 履歴選択の軌跡端点も収める (全点だと重いので開始/最終のみ)
    for (const arr of extraTracks.values()) {
      if (arr.length === 0) continue
      const first = arr[0]
      const last = arr[arr.length - 1]
      rows.push({ lat: first.lat, lon: first.lon })
      if (last.id !== first.id) rows.push({ lat: last.lat, lon: last.lon })
    }
    return rows
  }, [latestPositions, markers, extraTracks])

  return (
    <div className="relative h-full w-full">
      {/* 右上オーバーレイ: 稼働数と再取得ボタン */}
      <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2 bg-white/95 rounded-lg border shadow px-3 py-1.5 text-xs">
        <span className="text-slate-600">
          稼働中 {markers.length} / {activeAssignments.size}
        </span>
        <button
          type="button"
          onClick={refreshAll}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-0.5 border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          再取得
        </button>
      </div>

      {markers.length === 0 && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1000]">
          <div className="bg-white/95 border rounded-lg px-4 py-3 shadow text-sm text-slate-500 pointer-events-auto">
            現在地送信されている稼働中の車両はありません
          </div>
        </div>
      )}
      <MapContainer
        center={[35.681236, 139.767125]}
        zoom={5}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <AutoFitBounds positions={positionsForBounds} />
        {/* 稼働中車両ごとの走行軌跡 (assignment 単位で色分け) */}
        {Array.from(trackPositions.entries()).map(([assignmentId, points]) => {
          if (points.length < 2) return null
          const line = points.map((p) => [p.lat, p.lon] as [number, number])
          return (
            <Polyline
              key={`track-${assignmentId}`}
              positions={line}
              pathOptions={{
                color: colorForAssignment(assignmentId),
                weight: 3,
                opacity: 0.85,
              }}
            />
          )
        })}
        {/* サイドバー履歴チェックの追加軌跡 (稼働中と同じ色で描画。
            稼働中割当と重複したら trackPositions 側が上書きするので二重描画のみ) */}
        {Array.from(extraTracks.entries()).map(([assignmentId, points]) => {
          if (points.length < 2) return null
          if (trackPositions.has(assignmentId)) return null // 稼働中軌跡と重複
          const line = points.map((p) => [p.lat, p.lon] as [number, number])
          return (
            <Polyline
              key={`extra-track-${assignmentId}`}
              positions={line}
              pathOptions={{
                color: colorForAssignment(assignmentId),
                weight: 3,
                opacity: 0.85,
                dashArray: '4 6',
              }}
            />
          )
        })}
        {/* 各車両の「現在地→行き先」オレンジ破線 (行き先セット中のみ) */}
        {markers.map((m) => {
          if (!m.destination) return null
          return (
            <Polyline
              key={`dest-line-${m.assignmentId}`}
              positions={[
                [m.lat, m.lon],
                [m.destination.lat, m.destination.lon],
              ]}
              pathOptions={{
                color: '#f59e0b',
                weight: 3,
                opacity: 0.9,
                dashArray: '6 8',
              }}
            />
          )
        })}
        {/* 行き先ピン (複数車両が同じピンを見ていても重ねて表示) */}
        {markers.map((m) => {
          if (!m.destination) return null
          return (
            <Marker
              key={`dest-marker-${m.assignmentId}`}
              position={[m.destination.lat, m.destination.lon]}
              icon={buildDestinationIcon(m.destination.name)}
              zIndexOffset={1000}
            />
          )
        })}
        {markers.map((m) => {
          const parts: string[] = [m.vehicleName]
          if (m.speed_kmh != null && m.speed_kmh >= 0) {
            parts.push(`${Math.round(m.speed_kmh)}km/h`)
          }
          if (m.destination) {
            const dist = haversineMeters(
              { lat: m.lat, lon: m.lon },
              { lat: m.destination.lat, lon: m.destination.lon },
            )
            const deg = bearingDeg(
              { lat: m.lat, lon: m.lon },
              { lat: m.destination.lat, lon: m.destination.lon },
            )
            parts.push(
              `→${m.destination.name} (${bearingLabel(deg)} ${formatDistance(dist)})`,
            )
          }
          const label = parts.join(' ')
          return (
            <VehicleMarker
              key={m.assignmentId}
              position={[m.lat, m.lon]}
              heading={m.heading_deg}
              color={COLOR_ACTIVE}
              size={22}
              label={label}
              onClick={onSelectVehicle ? () => onSelectVehicle(m.vehicleId) : undefined}
            />
          )
        })}
      </MapContainer>
    </div>
  )
}
