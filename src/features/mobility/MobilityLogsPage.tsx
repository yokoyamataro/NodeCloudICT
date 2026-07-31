// 日別運行ログ画面 (/mobility/logs)
//
// - 日付ピッカーで対象日を選ぶ (既定: 今日)
// - その日に始まった assignment を全部取得 → ドライバー別にグループ化
// - 各ドライバーの走行距離・軌跡を集計
// - 地図: 全ドライバーの軌跡を色分けで重ね表示。ドライバー選択で単独表示
// - サイドバー: ドライバー一覧 (距離順) + 総距離
//
// URL: /mobility/logs?date=YYYY-MM-DD (省略時は今日)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar,
  Car,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  User,
} from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Tooltip,
  useMap,
} from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore, type AssignmentWithNames } from '@/stores/mobilityStore'
import { computeTotalDistanceMeters } from '@/lib/geoDistance'
import type { MobilityPosition, Vehicle } from '@/types/database'

// user_id からハッシュベースで安定した HSL 色を生成
function colorForUser(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return `hsl(${h % 360}, 70%, 50%)`
}

function parseDateParam(raw: string | null): Date {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(y, m - 1, d)
    if (!isNaN(dt.getTime())) return dt
  }
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return t
}

function formatDateParam(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function AutoFit({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length === 0) return
    if (positions.length === 1) {
      map.setView(positions[0], 15, { animate: false })
      return
    }
    const bounds: LatLngBoundsExpression = positions
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: false })
  }, [positions, map])
  return null
}

/** 1 乗車→降車 = 1 ユニット */
interface AssignmentUnit {
  assignmentId: string
  vehicleId: string
  vehicleName: string
  destinationName: string | null
  startedAt: string
  endedAt: string | null
  distanceM: number
  positions: MobilityPosition[]
}

interface UserAggregate {
  userId: string
  driverName: string
  distanceM: number
  units: AssignmentUnit[]
  positions: MobilityPosition[]
}

export function MobilityLogsPage() {
  const navigate = useNavigate()
  const canUse = useCanManageMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const [searchParams, setSearchParams] = useSearchParams()
  // URL の date パラメータをそのまま useMemo のキーにして、Date オブジェクトを
  // 参照安定させる。文字列を deps に使わないと毎レンダーで new Date() が作られ、
  // useEffect が無限に再実行されて loading=true のまま固まる。
  const dateParam = searchParams.get('date')
  const selectedDate = useMemo(() => parseDateParam(dateParam), [dateParam])

  const setDate = useCallback(
    (d: Date) => {
      const next = new URLSearchParams(searchParams)
      next.set('date', formatDateParam(d))
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const {
    vehicles,
    fetchVehicles,
    fetchOrgAssignmentsBetween,
    fetchPositionsForAssignments,
  } = useMobilityStore()

  const [assignments, setAssignments] = useState<AssignmentWithNames[]>([])
  const [positionsByAssignment, setPositionsByAssignment] = useState<
    Map<string, MobilityPosition[]>
  >(new Map())
  const [loading, setLoading] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
  }, [orgId, fetchVehicles])

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    setLoading(true)
    setSelectedUserId(null)
    setExpandedUserId(null)
    ;(async () => {
      const dayStart = new Date(selectedDate)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart)
      dayEnd.setDate(dayEnd.getDate() + 1)
      const rows = await fetchOrgAssignmentsBetween(
        orgId,
        dayStart.toISOString(),
        dayEnd.toISOString(),
      )
      if (cancelled) return
      setAssignments(rows)
      if (rows.length === 0) {
        setPositionsByAssignment(new Map())
        setLoading(false)
        return
      }
      const posMap = await fetchPositionsForAssignments(
        rows.map((r) => r.id),
        1000,
      )
      if (cancelled) return
      setPositionsByAssignment(posMap)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [orgId, selectedDate, fetchOrgAssignmentsBetween, fetchPositionsForAssignments])

  const vehicleById = useMemo(() => {
    const m = new Map<string, Vehicle>()
    for (const v of vehicles) m.set(v.id, v)
    return m
  }, [vehicles])

  // user_id ごとに集計。各 assignment を「単位 (乗車→降車)」として保持する。
  const perUser = useMemo<UserAggregate[]>(() => {
    const byUser = new Map<string, UserAggregate>()
    for (const a of assignments) {
      const pos = positionsByAssignment.get(a.id) ?? []
      const v = vehicleById.get(a.vehicle_id)
      const unit: AssignmentUnit = {
        assignmentId: a.id,
        vehicleId: a.vehicle_id,
        vehicleName: v?.name ?? '(不明車両)',
        destinationName: a.destination_point?.name ?? null,
        startedAt: a.started_at,
        endedAt: a.ended_at,
        distanceM: computeTotalDistanceMeters(pos),
        positions: pos,
      }
      const existing = byUser.get(a.user_id)
      if (existing) {
        existing.units.push(unit)
        existing.positions.push(...pos)
      } else {
        byUser.set(a.user_id, {
          userId: a.user_id,
          driverName: a.driver_name || '(名前未設定)',
          distanceM: 0,
          units: [unit],
          positions: [...pos],
        })
      }
    }
    // 集計 + ソート (単位は乗車時刻昇順)
    for (const u of byUser.values()) {
      u.units.sort(
        (x, y) =>
          new Date(x.startedAt).getTime() - new Date(y.startedAt).getTime(),
      )
      u.distanceM = u.units.reduce((sum, x) => sum + x.distanceM, 0)
      u.positions.sort(
        (a, b) =>
          new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
      )
    }
    return Array.from(byUser.values()).sort((a, b) => b.distanceM - a.distanceM)
  }, [assignments, positionsByAssignment, vehicleById])

  const totalDistanceM = useMemo(
    () => perUser.reduce((sum, u) => sum + u.distanceM, 0),
    [perUser],
  )

  // 表示対象 (全表示 or 選択ユーザー)
  const visibleUsers = useMemo(
    () => (selectedUserId ? perUser.filter((u) => u.userId === selectedUserId) : perUser),
    [perUser, selectedUserId],
  )
  const boundsPoints = useMemo(() => {
    const pts: [number, number][] = []
    for (const u of visibleUsers) {
      for (const p of u.positions) pts.push([p.lat, p.lon])
    }
    return pts
  }, [visibleUsers])

  const shiftDay = (deltaDays: number) => {
    const next = new Date(selectedDate)
    next.setDate(next.getDate() + deltaDays)
    setDate(next)
  }

  const isToday = useMemo(() => {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    return t.getTime() === selectedDate.getTime()
  }, [selectedDate])

  if (!canUse) return <Navigate to="/" replace />
  if (!orgId) return <Navigate to="/mobility" replace />

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* ヘッダ */}
      <div className="p-3 bg-white border-b flex items-center gap-2 shrink-0">
        <button
          onClick={() => navigate('/mobility')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="モビリティトップに戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Calendar className="h-5 w-5 text-indigo-600" />
        <h1 className="text-base font-bold">運行ログ</h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => shiftDay(-1)}
          className="p-1 rounded hover:bg-slate-100 text-slate-600"
          title="前日"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <input
          type="date"
          value={formatDateParam(selectedDate)}
          onChange={(e) => {
            const d = new Date(e.target.value)
            if (!isNaN(d.getTime())) setDate(d)
          }}
          className="px-2 py-1 text-sm border rounded"
        />
        <button
          type="button"
          onClick={() => shiftDay(1)}
          disabled={isToday}
          className="p-1 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-40"
          title="翌日"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
        {!isToday && (
          <button
            type="button"
            onClick={() => setDate(new Date())}
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
          >
            今日
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* 地図 */}
        <div className="h-72 lg:h-auto lg:flex-1 relative border-b lg:border-b-0 lg:border-r">
          {loading && (
            <div className="absolute top-3 left-3 z-[1000] bg-white/95 rounded border px-2 py-1 text-xs shadow flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> 読み込み中...
            </div>
          )}
          {!loading && boundsPoints.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1000]">
              <div className="bg-white/95 border rounded-lg px-4 py-3 shadow text-sm text-slate-500 pointer-events-auto">
                この日の走行ログはありません
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
            <AutoFit positions={boundsPoints} />
            {visibleUsers.map((u) => {
              if (u.positions.length < 2) return null
              const line = u.positions.map(
                (p) => [p.lat, p.lon] as [number, number],
              )
              const color = colorForUser(u.userId)
              return (
                <Polyline
                  key={`track-${u.userId}`}
                  positions={line}
                  pathOptions={{ color, weight: 3, opacity: 0.85 }}
                />
              )
            })}
            {visibleUsers.map((u) => {
              const first = u.positions[0]
              const last = u.positions[u.positions.length - 1]
              const color = colorForUser(u.userId)
              return (
                <>
                  {first && (
                    <CircleMarker
                      key={`start-${u.userId}`}
                      center={[first.lat, first.lon]}
                      radius={6}
                      pathOptions={{
                        color: '#ffffff',
                        fillColor: '#22c55e',
                        fillOpacity: 1,
                        weight: 2,
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -6]}>
                        {u.driverName} 開始
                      </Tooltip>
                    </CircleMarker>
                  )}
                  {last && last.id !== first?.id && (
                    <CircleMarker
                      key={`end-${u.userId}`}
                      center={[last.lat, last.lon]}
                      radius={7}
                      pathOptions={{
                        color: '#ffffff',
                        fillColor: color,
                        fillOpacity: 1,
                        weight: 2,
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -6]}>
                        {u.driverName} 最終
                      </Tooltip>
                    </CircleMarker>
                  )}
                </>
              )
            })}
          </MapContainer>
        </div>

        {/* サイドパネル */}
        <div className="lg:w-96 xl:w-[28rem] overflow-y-auto p-4 space-y-4">
          {/* 総距離 */}
          <div className="p-3 bg-white rounded-lg border">
            <div className="text-[10px] text-slate-500">総走行距離</div>
            <div className="text-3xl font-bold leading-tight text-slate-800">
              {(totalDistanceM / 1000).toFixed(1)}
              <span className="text-sm font-normal text-slate-500 ml-1">km</span>
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {formatDateParam(selectedDate)} · 全ドライバー合計
            </div>
          </div>

          {/* ドライバー一覧 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-5 rounded bg-indigo-500" />
              <h2 className="text-sm font-semibold text-slate-700 flex-1">
                ドライバー ({perUser.length})
              </h2>
              {selectedUserId && (
                <button
                  type="button"
                  onClick={() => setSelectedUserId(null)}
                  className="text-[10px] text-indigo-600 hover:underline"
                >
                  全表示
                </button>
              )}
            </div>
            {perUser.length === 0 && !loading ? (
              <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                この日の運行はありません
              </div>
            ) : (
              <ul className="space-y-1">
                {perUser.map((u) => {
                  const isSelected = selectedUserId === u.userId
                  const isExpanded = expandedUserId === u.userId
                  const color = colorForUser(u.userId)
                  return (
                    <li
                      key={u.userId}
                      className={`bg-white rounded border ${
                        isSelected
                          ? 'ring-1 ring-indigo-500 border-indigo-400'
                          : ''
                      }`}
                    >
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedUserId(isSelected ? null : u.userId)
                          }
                          className="flex-1 flex items-center gap-2 p-2 text-xs text-left hover:bg-slate-50 min-w-0"
                          title="クリックでこのドライバーだけ地図に表示"
                        >
                          <span
                            className="inline-block h-3 w-3 rounded-full shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <User className="h-3 w-3 text-slate-400 shrink-0" />
                          <span className="flex-1 min-w-0 truncate font-medium">
                            {u.driverName}
                          </span>
                          <span className="text-slate-500 shrink-0">
                            {u.units.length} 回
                          </span>
                          <span className="text-slate-800 shrink-0 w-16 text-right font-semibold">
                            {(u.distanceM / 1000).toFixed(1)} km
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedUserId(isExpanded ? null : u.userId)
                          }
                          className="p-2 text-slate-400 hover:text-slate-700 shrink-0"
                          title={isExpanded ? '折りたたむ' : '単位ごとの内訳を表示'}
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                      </div>
                      {isExpanded && (
                        <ul className="border-t divide-y bg-slate-50/60">
                          {u.units.map((unit) => (
                            <li
                              key={unit.assignmentId}
                              className="px-3 py-2 text-[11px]"
                            >
                              <div className="flex items-center gap-1.5 text-slate-700">
                                <Car className="h-3 w-3 text-slate-400 shrink-0" />
                                <span className="font-medium truncate flex-1">
                                  {unit.vehicleName}
                                </span>
                                <span className="text-slate-800 font-semibold shrink-0">
                                  {(unit.distanceM / 1000).toFixed(2)} km
                                </span>
                              </div>
                              <div className="text-slate-500 mt-0.5 flex items-center gap-1">
                                <span>
                                  {new Date(unit.startedAt).toLocaleTimeString(
                                    'ja-JP',
                                    { hour: '2-digit', minute: '2-digit' },
                                  )}
                                </span>
                                <span>–</span>
                                <span>
                                  {unit.endedAt
                                    ? new Date(unit.endedAt).toLocaleTimeString(
                                        'ja-JP',
                                        { hour: '2-digit', minute: '2-digit' },
                                      )
                                    : '(乗車中)'}
                                </span>
                              </div>
                              {unit.destinationName && (
                                <div className="text-amber-700 mt-0.5 flex items-center gap-1 truncate">
                                  <MapPin className="h-3 w-3 shrink-0" />
                                  <span className="truncate">
                                    行き先: {unit.destinationName}
                                  </span>
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
