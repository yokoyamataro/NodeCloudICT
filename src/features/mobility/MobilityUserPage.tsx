// 個別ユーザーの詳細画面 (/mobility/users/:userId)。
//
// 車両詳細画面 (MobilityVehiclePage) のユーザー版。
//   ・ユーザー基本情報 (org_members から取得)
//   ・本日走行距離 (自分の全 assignment を横断集計)
//   ・現在の割当 (乗車中なら車両名 + 開始時刻)
//   ・本日の運行履歴 (assignments 一覧、距離バッジ付き)
//   ・地図: 本日走行の polyline

import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Car, Loader2, User } from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  Tooltip,
  useMap,
} from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import { computeTotalDistanceMeters } from '@/lib/geoDistance'
import type { MobilityPosition, VehicleAssignment } from '@/types/database'

interface OrgMemberRow {
  user_id: string
  email: string
  full_name: string | null
  role: 'admin' | 'member'
  joined_at: string
}

function startOfTodayLocal(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function AutoFitTrack({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length === 0) return
    if (positions.length === 1) {
      map.setView(positions[0], 15, { animate: false })
      return
    }
    const bounds: LatLngBoundsExpression = positions
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: false })
  }, [positions, map])
  return null
}

export function MobilityUserPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const canUse = useCanManageMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const { vehicles, fetchVehicles, fetchPositionsForUserSince } = useMobilityStore()

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
  }, [orgId, fetchVehicles])

  const [member, setMember] = useState<OrgMemberRow | null>(null)
  const [assignments, setAssignments] = useState<VehicleAssignment[]>([])
  const [positions, setPositions] = useState<MobilityPosition[]>([])
  const [loading, setLoading] = useState(true)

  // 組織メンバー情報を取得
  useEffect(() => {
    if (!orgId || !userId) return
    let cancelled = false
    ;(async () => {
      const { data } = (await supabase.rpc(
        'list_org_members' as never,
        { p_org_id: orgId } as never,
      )) as unknown as { data: OrgMemberRow[] | null; error: unknown }
      if (cancelled) return
      const found = (data ?? []).find((m) => m.user_id === userId) ?? null
      setMember(found)
    })()
    return () => {
      cancelled = true
    }
  }, [orgId, userId])

  // 本日のポジション + 割当を取得
  useEffect(() => {
    if (!userId) return
    const sinceIso = startOfTodayLocal().toISOString()
    let cancelled = false
    setLoading(true)
    ;(async () => {
      // ポジション
      const pos = await fetchPositionsForUserSince(userId, sinceIso)
      // 割当 (別途 query)
      const { data: aRows } = await supabase
        .from('vehicle_assignments')
        .select('*')
        .eq('user_id', userId)
        .gte('started_at', sinceIso)
        .order('started_at', { ascending: false })
      if (cancelled) return
      setPositions(pos)
      setAssignments((aRows ?? []) as VehicleAssignment[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [userId, fetchPositionsForUserSince])

  // 現在稼働中の割当
  const activeAssignment = useMemo(
    () => assignments.find((a) => a.ended_at == null) ?? null,
    [assignments],
  )

  // ポジションを assignment_id ごとにグループ化
  const positionsByAssignment = useMemo(() => {
    const map = new Map<string, MobilityPosition[]>()
    for (const p of positions) {
      const arr = map.get(p.assignment_id)
      if (arr) arr.push(p)
      else map.set(p.assignment_id, [p])
    }
    return map
  }, [positions])

  // 本日走行距離 (全 assignment 合算)
  const todayDistanceM = useMemo(() => {
    let total = 0
    for (const rows of positionsByAssignment.values()) {
      total += computeTotalDistanceMeters(rows)
    }
    return total
  }, [positionsByAssignment])

  // 現在速度 (稼働中割当の最新位置)
  const currentSpeedKmh = useMemo(() => {
    if (!activeAssignment) return null
    const rows = positionsByAssignment.get(activeAssignment.id)
    if (!rows || rows.length === 0) return null
    return rows[rows.length - 1].speed_kmh
  }, [activeAssignment, positionsByAssignment])

  // 稼働中車両
  const activeVehicle = useMemo(
    () =>
      activeAssignment
        ? vehicles.find((v) => v.id === activeAssignment.vehicle_id) ?? null
        : null,
    [activeAssignment, vehicles],
  )

  const mapPoints = useMemo(
    () => positions.map((p) => [p.lat, p.lon] as [number, number]),
    [positions],
  )
  const startPoint = positions[0]
  const endPoint = positions[positions.length - 1]

  if (!canUse) return <Navigate to="/" replace />
  if (!userId) return <Navigate to="/mobility" replace />

  return (
    <div className="h-full flex flex-col bg-slate-50 overflow-auto">
      <div className="p-4 bg-white border-b flex items-center gap-3 shrink-0">
        <button
          onClick={() => navigate('/mobility')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="モビリティトップに戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <User className="h-5 w-5 text-indigo-600" />
        <h1 className="text-lg font-bold truncate flex-1">
          {member?.full_name || member?.email || '(読み込み中)'}
        </h1>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* 基本情報 */}
        <section className="bg-white rounded-lg border p-4">
          <div className="grid grid-cols-[8rem_1fr] gap-y-2 gap-x-2 text-sm">
            <div className="text-slate-500">氏名</div>
            <div className="font-medium">{member?.full_name || '(未設定)'}</div>
            <div className="text-slate-500">メール</div>
            <div>{member?.email || '—'}</div>
            <div className="text-slate-500">役割</div>
            <div>
              {member?.role === 'admin' ? (
                <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 border border-amber-300">
                  管理者
                </span>
              ) : member?.role === 'member' ? (
                '一般'
              ) : (
                '—'
              )}
            </div>
          </div>
        </section>

        {/* 速度・本日走行距離パネル */}
        <section className="grid grid-cols-2 gap-2">
          <div className="p-3 bg-white rounded-lg border">
            <div className="text-[10px] text-slate-500">現在速度</div>
            <div className="text-2xl font-bold leading-tight text-slate-800">
              {activeAssignment && currentSpeedKmh != null && currentSpeedKmh >= 0
                ? Math.round(currentSpeedKmh)
                : '—'}
              <span className="text-xs font-normal text-slate-500 ml-1">km/h</span>
            </div>
            {!activeAssignment && (
              <div className="text-[10px] text-slate-400 mt-0.5">
                稼働中の割当なし
              </div>
            )}
          </div>
          <div className="p-3 bg-white rounded-lg border">
            <div className="text-[10px] text-slate-500">本日走行 (このドライバー)</div>
            <div className="text-2xl font-bold leading-tight text-slate-800">
              {(todayDistanceM / 1000).toFixed(1)}
              <span className="text-xs font-normal text-slate-500 ml-1">km</span>
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              00:00 〜 · 全 assignment 合算
            </div>
          </div>
        </section>

        {/* 現在の乗車 */}
        {activeAssignment && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-5 rounded bg-emerald-500" />
              <h2 className="text-sm font-semibold text-slate-700">現在の乗車</h2>
            </div>
            <div
              className="p-3 bg-white rounded border flex items-center gap-3 hover:border-indigo-400 cursor-pointer"
              onClick={() =>
                activeVehicle && navigate(`/mobility/vehicles/${activeVehicle.id}`)
              }
            >
              <div className="h-9 w-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <Car className="h-4 w-4 text-emerald-700" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {activeVehicle?.name ?? '(不明車両)'}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  開始:{' '}
                  {new Date(activeAssignment.started_at).toLocaleTimeString(
                    'ja-JP',
                    { hour: '2-digit', minute: '2-digit' },
                  )}
                </div>
              </div>
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                稼働中
              </span>
            </div>
          </section>
        )}

        {/* 本日の運行履歴 (地図) */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-5 rounded bg-indigo-500" />
            <h2 className="text-sm font-semibold text-slate-700 flex-1">
              本日の走行軌跡
            </h2>
            {loading && <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />}
          </div>
          <div
            className="rounded border overflow-hidden bg-slate-100"
            style={{ height: 320 }}
          >
            {mapPoints.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                本日の位置ログはありません
              </div>
            ) : (
              <MapContainer
                center={startPoint ? [startPoint.lat, startPoint.lon] : [35.681236, 139.767125]}
                zoom={15}
                className="h-full w-full"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <AutoFitTrack positions={mapPoints} />
                {mapPoints.length > 1 && (
                  <Polyline
                    positions={mapPoints}
                    pathOptions={{ color: '#6366f1', weight: 4 }}
                  />
                )}
                {startPoint && (
                  <CircleMarker
                    center={[startPoint.lat, startPoint.lon]}
                    radius={7}
                    pathOptions={{
                      color: '#ffffff',
                      fillColor: '#22c55e',
                      fillOpacity: 1,
                      weight: 2,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -6]}>
                      開始
                    </Tooltip>
                  </CircleMarker>
                )}
                {endPoint && endPoint.id !== startPoint?.id && (
                  <CircleMarker
                    center={[endPoint.lat, endPoint.lon]}
                    radius={8}
                    pathOptions={{
                      color: '#ffffff',
                      fillColor: activeAssignment ? '#ef4444' : '#64748b',
                      fillOpacity: 1,
                      weight: 2,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -6]}>
                      最新
                    </Tooltip>
                  </CircleMarker>
                )}
              </MapContainer>
            )}
          </div>
        </section>

        {/* 本日の運行履歴 (割当一覧) */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-5 rounded bg-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700 flex-1">
              本日の運行 ({assignments.length})
            </h2>
          </div>
          {assignments.length === 0 && !loading ? (
            <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
              本日の運行はありません
            </div>
          ) : (
            <ul className="space-y-1">
              {assignments.map((a) => {
                const v = vehicles.find((vv) => vv.id === a.vehicle_id)
                const rows = positionsByAssignment.get(a.id)
                const distKm = rows
                  ? computeTotalDistanceMeters(rows) / 1000
                  : 0
                const durationMs = a.ended_at
                  ? new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()
                  : Date.now() - new Date(a.started_at).getTime()
                const hours = Math.floor(durationMs / (60 * 60 * 1000))
                const mins = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000))
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() =>
                        v && navigate(`/mobility/vehicles/${v.id}`)
                      }
                      className="w-full flex items-center gap-2 p-2 bg-white rounded border text-xs text-left hover:border-indigo-400"
                      title="この割当の車両詳細を開く"
                    >
                      <Car className="h-3 w-3 text-slate-400 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">
                        {v?.name ?? '(不明車両)'}
                      </span>
                      <span className="text-slate-500 shrink-0">
                        {new Date(a.started_at).toLocaleTimeString('ja-JP', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {a.ended_at ? (
                          <>
                            {' '}
                            〜{' '}
                            {new Date(a.ended_at).toLocaleTimeString('ja-JP', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </>
                        ) : (
                          <span className="ml-1 text-emerald-600">(稼働中)</span>
                        )}
                      </span>
                      <span className="text-slate-400 shrink-0 w-14 text-right">
                        {hours}h {mins}m
                      </span>
                      <span className="text-slate-500 shrink-0 w-14 text-right font-medium">
                        {distKm.toFixed(1)} km
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
