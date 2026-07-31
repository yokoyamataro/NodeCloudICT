// 稼働中車両を地図上に描くビュー (単独ページ用ではなく組込コンポーネント)。
//
// - 組織内の active assignment × 最新位置をマーカー表示
// - Supabase Realtime で mobility_positions INSERT を購読
// - onMarkerClick で親コンポーネントに車両クリックを通知

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import { VehicleMarker } from '@/features/mobility/VehicleMarker'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, RotateCcw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useMobilityStore } from '@/stores/mobilityStore'
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

function AutoFitBounds({ positions }: { positions: MobilityPosition[] }) {
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
}

export function FleetMapView({ organizationId, onSelectVehicle }: FleetMapViewProps) {
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
    }[] = []
    for (const [assignmentId, pos] of latestPositions) {
      const assignment = Array.from(activeAssignments.values()).find(
        (a) => a.id === assignmentId,
      )
      if (!assignment) continue
      const vehicle = vehicles.find((v) => v.id === assignment.vehicle_id)
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
      })
    }
    return rows
  }, [latestPositions, activeAssignments, vehicles])

  const positionsForBounds = useMemo(
    () => Array.from(latestPositions.values()),
    [latestPositions],
  )

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
        {markers.map((m) => {
          const label = m.speed_kmh != null && m.speed_kmh >= 0
            ? `${m.vehicleName} ${Math.round(m.speed_kmh)}km/h`
            : m.vehicleName
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
