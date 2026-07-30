// 管理者向けフリート地図 (/mobility/map)
//
// 組織内で現在稼働中の全車両の現在地をマップに一括表示する。
// 各マーカーは車両単位で、Popup でドライバー名・最終送信時刻を出す。
//
// リアルタイム:
//   Supabase Realtime で mobility_positions INSERT を購読し、
//   自組織の active assignment に紐づく ping が来たら該当マーカーを移動。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowLeft, Car, Loader2, RotateCcw } from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Tooltip,
  useMap,
} from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type { MobilityPosition } from '@/types/database'

// 車両マーカーの色 (稼働中は緑, 停止直後は amber)。
const COLOR_ACTIVE = '#10b981'

// 地図中心を初回セット (ping が入ってきたときに全マーカーが収まるように fitBounds)
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

export function MobilityFleetMapPage() {
  const navigate = useNavigate()
  const canUse = useCanUseMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const {
    vehicles,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    fetchLatestPositions,
  } = useMobilityStore()

  const [latestPositions, setLatestPositions] = useState<
    Map<string, MobilityPosition>
  >(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 初期ロード
  const refreshAll = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    setError(null)
    try {
      await fetchVehicles(orgId)
      await fetchActiveAssignments(orgId)
      const ids = Array.from(useMobilityStore.getState().activeAssignments.values()).map(
        (a) => a.id,
      )
      const positions = await fetchLatestPositions(ids)
      setLatestPositions(positions)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [orgId, fetchVehicles, fetchActiveAssignments, fetchLatestPositions])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // Supabase Realtime: mobility_positions INSERT を購読して現在地マーカーを更新
  useEffect(() => {
    if (!orgId) return
    const channel = supabase
      .channel(`mobility-positions-fleet-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mobility_positions' },
        (payload) => {
          const row = payload.new as MobilityPosition | undefined
          if (!row) return
          // 自組織の active assignment に属するもののみ反映
          const active = useMobilityStore.getState().activeAssignments
          const isOurs = Array.from(active.values()).some(
            (a) => a.id === row.assignment_id,
          )
          if (!isOurs) return
          setLatestPositions((prev) => {
            const next = new Map(prev)
            const existing = next.get(row.assignment_id)
            // より新しい timestamp なら差し替え
            if (
              !existing ||
              new Date(row.recorded_at).getTime() >
                new Date(existing.recorded_at).getTime()
            ) {
              next.set(row.assignment_id, row)
            }
            return next
          })
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [orgId])

  // マーカー描画用データ (assignmentId => { position, vehicle, driverName })
  const markers = useMemo(() => {
    const rows: {
      assignmentId: string
      lat: number
      lon: number
      vehicleName: string
      driverName: string
      recordedAt: string
      accuracy_m: number | null
    }[] = []
    for (const [assignmentId, pos] of latestPositions) {
      const assignment = Array.from(activeAssignments.values()).find(
        (a) => a.id === assignmentId,
      )
      if (!assignment) continue
      const vehicle = vehicles.find((v) => v.id === assignment.vehicle_id)
      rows.push({
        assignmentId,
        lat: pos.lat,
        lon: pos.lon,
        vehicleName: vehicle?.name ?? '(不明車両)',
        driverName: assignment.driver_name ?? '(名前未設定)',
        recordedAt: pos.recorded_at,
        accuracy_m: pos.accuracy_m,
      })
    }
    return rows
  }, [latestPositions, activeAssignments, vehicles])

  const positionsForBounds = useMemo(
    () => Array.from(latestPositions.values()),
    [latestPositions],
  )

  const activeCount = activeAssignments.size
  const withPositionCount = markers.length

  if (!canUse) return <Navigate to="/" replace />
  if (!orgId) return <Navigate to="/mobility" replace />

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-3 bg-white border-b flex items-center gap-3 shrink-0">
        <button
          onClick={() => navigate('/mobility')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="モビリティトップに戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Car className="h-5 w-5 text-indigo-600" />
        <h1 className="text-base font-bold flex-1">フリート地図</h1>
        <span className="text-xs text-slate-500 shrink-0">
          稼働中 {withPositionCount} / {activeCount}
        </span>
        <button
          onClick={refreshAll}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          再取得
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 relative">
        {markers.length === 0 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1000]">
            <div className="bg-white/95 border rounded-lg px-4 py-3 shadow text-sm text-slate-500 pointer-events-auto">
              現在地送信されている稼働中の車両はありません
            </div>
          </div>
        )}
        <MapContainer
          center={[35.681236, 139.767125]} // fallback: 東京駅
          zoom={5}
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <AutoFitBounds positions={positionsForBounds} />
          {markers.map((m) => (
            <CircleMarker
              key={m.assignmentId}
              center={[m.lat, m.lon]}
              radius={9}
              pathOptions={{
                color: COLOR_ACTIVE,
                fillColor: COLOR_ACTIVE,
                fillOpacity: 0.85,
                weight: 2,
              }}
            >
              <Tooltip
                direction="top"
                offset={[0, -8]}
                permanent
                className="!bg-white !border !border-slate-300 !text-slate-800 !font-medium"
              >
                {m.vehicleName}
              </Tooltip>
              <Popup>
                <div className="text-xs space-y-1">
                  <div className="font-semibold">{m.vehicleName}</div>
                  <div className="text-slate-600">
                    ドライバー: {m.driverName}
                  </div>
                  <div className="text-slate-500">
                    最終送信:{' '}
                    {new Date(m.recordedAt).toLocaleTimeString('ja-JP', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </div>
                  {m.accuracy_m != null && (
                    <div className="text-slate-400">
                      精度: ±{Math.round(m.accuracy_m)}m
                    </div>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
