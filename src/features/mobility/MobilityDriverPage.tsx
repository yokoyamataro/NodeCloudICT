// モバイル向け ドライバー中心画面 (/mobility/drive)
//
// 特徴:
//   ・全画面地図がベース
//   ・上部ヘッダに現在の車両/割当情報
//   ・下部に大きな行動ボタン
//       - 割当なし: 「乗車」→ 車両ピッカー
//       - 自分の割当あり: 「現在地を送信」「降車」
//       - 他人の割当: 読み取り専用 (別画面推奨)
//   ・現在地は Geolocation で自動追跡し watchPosition で連続送信
//     (画面表示中のみ。バックグラウンドは Capacitor 統合で対応)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Car,
  Construction,
  Loader2,
  LogOut,
  Play,
  Send,
  Truck,
  X,
} from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type { MobilityPosition, Vehicle, VehicleKind } from '@/types/database'

const KIND_LABEL: Record<VehicleKind, string> = {
  car: '普通車',
  truck: 'トラック',
  heavy_equipment: '重機',
  other: 'その他',
}

const KIND_ICON: Record<VehicleKind, typeof Car> = {
  car: Car,
  truck: Truck,
  heavy_equipment: Construction,
  other: Car,
}

// 送信間隔 (ms)
const PING_INTERVAL_MS = 10_000

function FollowMe({ pos }: { pos: [number, number] | null }) {
  const map = useMap()
  useEffect(() => {
    if (pos) map.setView(pos, Math.max(map.getZoom(), 15), { animate: true })
  }, [pos, map])
  return null
}

export function MobilityDriverPage() {
  const navigate = useNavigate()
  const canUse = useCanUseMobility()
  const { user, profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const {
    vehicles,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    startAssignment,
    endAssignment,
    sendPosition,
    fetchRecentPositions,
  } = useMobilityStore()

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  // 自分の稼働中割当を探す
  const myActive = useMemo(() => {
    if (!user) return null
    return (
      Array.from(activeAssignments.values()).find((a) => a.user_id === user.id) ??
      null
    )
  }, [activeAssignments, user])

  const myVehicle = useMemo(
    () => (myActive ? vehicles.find((v) => v.id === myActive.vehicle_id) : null),
    [myActive, vehicles],
  )

  // Geolocation
  const [currentPos, setCurrentPos] = useState<[number, number] | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError('この端末では位置情報を取得できません')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setCurrentPos([p.coords.latitude, p.coords.longitude])
        setAccuracy(p.coords.accuracy)
        setLocationError(null)
      },
      (err) => {
        setLocationError(
          err.code === 1
            ? '位置情報の許可が必要です'
            : err.code === 2
              ? '位置情報を取得できません'
              : 'タイムアウトしました',
        )
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // 自分の active assignment がある間、一定間隔で ping を送る。
  //   GPS 更新のたびに currentPos が変わるが、useEffect の依存に入れると
  //   setInterval が毎回 clear/reset されて永遠に発火しないバグになるため、
  //   currentPos/accuracy は ref に流して依存から外す。
  const lastSentAtRef = useRef<number>(0)
  const currentPosRef = useRef<[number, number] | null>(null)
  const accuracyRef = useRef<number | null>(null)
  useEffect(() => {
    currentPosRef.current = currentPos
    accuracyRef.current = accuracy
  }, [currentPos, accuracy])

  const [autoSend, setAutoSend] = useState(false)
  useEffect(() => {
    if (!myActive || !autoSend) return
    const send = async () => {
      const pos = currentPosRef.current
      if (!pos) return
      const now = Date.now()
      if (now - lastSentAtRef.current < PING_INTERVAL_MS - 500) return
      lastSentAtRef.current = now
      await sendPosition(myActive.id, {
        lat: pos[0],
        lon: pos[1],
        accuracy_m: accuracyRef.current,
      })
    }
    // 初回はすぐ 1 発。そのあと定期送信。
    void send()
    const timer = setInterval(send, PING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [myActive, autoSend, sendPosition])

  // 走行軌跡 (自分の active assignment のもの)
  const [trackPositions, setTrackPositions] = useState<MobilityPosition[]>([])
  useEffect(() => {
    if (!myActive) {
      setTrackPositions([])
      return
    }
    let cancelled = false
    void (async () => {
      const rows = await fetchRecentPositions(myActive.id, 200)
      if (!cancelled) setTrackPositions(rows)
    })()
    return () => {
      cancelled = true
    }
  }, [myActive, fetchRecentPositions])

  // ping を送るたびに軌跡も伸ばす
  const handleManualSend = useCallback(async () => {
    if (!myActive || !currentPos) return
    const res = await sendPosition(myActive.id, {
      lat: currentPos[0],
      lon: currentPos[1],
      accuracy_m: accuracy,
    })
    if (res.ok) {
      // 軌跡を再取得 (簡易: サーバから 1 件だけ足す方が理想)
      const rows = await fetchRecentPositions(myActive.id, 200)
      setTrackPositions(rows)
    }
  }, [myActive, currentPos, accuracy, sendPosition, fetchRecentPositions])

  const [showPicker, setShowPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyError, setBusyError] = useState<string | null>(null)

  const handleBoard = async (vehicleId: string) => {
    setBusyError(null)
    setBusy(true)
    try {
      const res = await startAssignment(vehicleId)
      if (!res) throw new Error(useMobilityStore.getState().vehiclesError ?? '開始に失敗')
      setShowPicker(false)
      setAutoSend(true) // 乗車と同時に自動送信 ON
    } catch (err) {
      setBusyError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleLeave = async () => {
    if (!myActive) return
    if (!confirm(`「${myVehicle?.name ?? '車両'}」から降車しますか?`)) return
    setBusy(true)
    try {
      await endAssignment(myActive.id)
      setAutoSend(false)
    } catch (err) {
      setBusyError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!canUse) return <Navigate to="/" replace />

  const trackLine = useMemo(
    () =>
      trackPositions
        .slice()
        .reverse()
        .map((p) => [p.lat, p.lon] as [number, number]),
    [trackPositions],
  )

  return (
    <div className="mobile-screen flex flex-col bg-slate-900 relative">
      {/* ヘッダ */}
      <div className="p-3 bg-slate-800 text-white flex items-center gap-2 shrink-0">
        <button
          onClick={() => navigate('/mobility')}
          className="p-1 rounded hover:bg-slate-700"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Car className="h-5 w-5 text-indigo-300" />
        <div className="flex-1 min-w-0">
          {myActive && myVehicle ? (
            <>
              <div className="text-sm font-semibold truncate">
                {myVehicle.name}
              </div>
              <div className="text-[10px] text-slate-300">
                {KIND_LABEL[myVehicle.kind]} · 稼働中
              </div>
            </>
          ) : (
            <div className="text-sm">乗車待ち</div>
          )}
        </div>
        {locationError && (
          <span className="text-[10px] text-amber-300 max-w-[8rem] text-right">
            {locationError}
          </span>
        )}
      </div>

      {/* 地図 */}
      <div className="flex-1 relative">
        <MapContainer
          center={[35.681236, 139.767125]}
          zoom={15}
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FollowMe pos={currentPos} />
          {trackLine.length > 1 && (
            <Polyline positions={trackLine} pathOptions={{ color: '#6366f1', weight: 4 }} />
          )}
          {currentPos && (
            <CircleMarker
              center={currentPos}
              radius={9}
              pathOptions={{
                color: '#ffffff',
                fillColor: myActive ? '#10b981' : '#3b82f6',
                fillOpacity: 1,
                weight: 3,
              }}
            />
          )}
        </MapContainer>
      </div>

      {busyError && (
        <div className="mx-3 my-2 p-2 bg-red-900/60 border border-red-700 rounded text-xs text-red-100">
          {busyError}
        </div>
      )}

      {/* フッタアクション */}
      <div className="p-3 bg-slate-800 flex gap-2 shrink-0">
        {myActive ? (
          <>
            <button
              onClick={handleManualSend}
              disabled={busy || !currentPos}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-3 text-sm font-semibold bg-sky-600 text-white rounded-lg disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              現在地を送信
            </button>
            <button
              onClick={() => setAutoSend((v) => !v)}
              disabled={busy}
              className={`px-3 py-3 text-xs rounded-lg font-semibold ${
                autoSend
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-600 text-slate-200'
              }`}
              title={autoSend ? '自動送信 ON' : '自動送信 OFF'}
            >
              {autoSend ? '自動 ON' : '自動 OFF'}
            </button>
            <button
              onClick={handleLeave}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-3 text-sm border border-red-500 text-red-300 rounded-lg disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              降車
            </button>
          </>
        ) : (
          <button
            onClick={() => setShowPicker(true)}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-3 text-base font-semibold bg-indigo-600 text-white rounded-lg disabled:opacity-50"
          >
            <Play className="h-5 w-5" />
            車両に乗車
          </button>
        )}
      </div>

      {showPicker && (
        <VehiclePickerSheet
          vehicles={vehicles.filter((v) => v.active)}
          activeAssignments={activeAssignments}
          onPick={handleBoard}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

function VehiclePickerSheet({
  vehicles,
  activeAssignments,
  onPick,
  onClose,
}: {
  vehicles: Vehicle[]
  activeAssignments: Map<string, { id: string; driver_name: string | null }>
  onPick: (vehicleId: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end z-[9999]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">乗車する車両を選ぶ</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {vehicles.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              稼働可能な車両がありません
            </div>
          ) : (
            <ul className="divide-y">
              {vehicles.map((v) => {
                const busyBy = activeAssignments.get(v.id)
                const Icon = KIND_ICON[v.kind]
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => !busyBy && onPick(v.id)}
                      disabled={!!busyBy}
                      className="w-full flex items-center gap-3 p-4 text-left disabled:opacity-40 active:bg-indigo-50"
                    >
                      <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                        <Icon className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {v.name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {KIND_LABEL[v.kind]}
                          {v.plate_or_serial && ` · ${v.plate_or_serial}`}
                        </div>
                      </div>
                      {busyBy && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 border border-amber-300">
                          {busyBy.driver_name || '他ユーザー'} 乗車中
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
