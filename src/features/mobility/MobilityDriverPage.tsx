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
import { watchSamples, watchSamplesInBackground } from '@/lib/geolocation'
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

  // Geolocation & 自動送信
  //
  //   モバイルブラウザで setInterval は throttle され期待通り発火しないことが
  //   多いため、watchPosition のコールバック内で throttled send する方式に変更。
  //   GPS が動くたびに来る (通常 1-3 秒) ので、10 秒経っていたら送る。
  //
  //   autoSend / myActive は ref に逃がして watch を再登録しない。再登録すると
  //   位置権限プロンプトが再表示されたり最終取得位置が失われたりして UX が悪い。
  const [currentPos, setCurrentPos] = useState<[number, number] | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [lastAutoSentAt, setLastAutoSentAt] = useState<Date | null>(null)
  const [autoSend, setAutoSend] = useState(false)

  const autoSendRef = useRef(false)
  const myActiveRef = useRef<typeof myActive>(null)
  const lastSentAtRef = useRef<number>(0)
  useEffect(() => {
    autoSendRef.current = autoSend
  }, [autoSend])
  useEffect(() => {
    myActiveRef.current = myActive
    // 割当が消えたら送信間隔もリセット (次に乗車した時はすぐ 1 発送る)
    if (!myActive) {
      lastSentAtRef.current = 0
      setLastAutoSentAt(null)
    }
  }, [myActive])

  const sendPositionRef = useRef(sendPosition)
  useEffect(() => {
    sendPositionRef.current = sendPosition
  }, [sendPosition])

  // 「自動 ON」に切り替えた瞬間は 1 発すぐ送る (次の watchPosition を待たない)
  useEffect(() => {
    if (!autoSend || !myActive) return
    const pos = currentPos
    if (!pos) return
    lastSentAtRef.current = Date.now()
    setLastAutoSentAt(new Date())
    void sendPosition(myActive.id, {
      lat: pos[0],
      lon: pos[1],
      accuracy_m: accuracy,
    })
    // 依存に currentPos は入れない (何度も送らないため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, myActive, sendPosition])

  // ------------------------------------------------------------------
  // バックグラウンド追跡 (4-e 後半)
  //   自動 ON + 乗車中 の間、background-geolocation プラグインで watcher を
  //   セット。Android では foreground service + 常駐通知が立ち、アプリを閉じても
  //   位置送信が継続する。フォアグラウンドの watchSamples とは独立に動くが、
  //   同じ GPS プロバイダを共有するのでバッテリー消費は 2 倍にはならない。
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!autoSend || !myActive) return
    let handle: { clear: () => Promise<void> } | null = null
    let cancelled = false
    void (async () => {
      try {
        handle = await watchSamplesInBackground(
          (sample, err) => {
            if (err) {
              // 通知だけ出す (フォアグラウンド watch のエラーで既に表示済みかもしれない)
              console.warn('[MobilityDriverPage] bg geo error', err)
              return
            }
            if (!sample) return
            const active = myActiveRef.current
            if (!autoSendRef.current || !active) return
            const now = Date.now()
            if (now - lastSentAtRef.current < PING_INTERVAL_MS) return
            lastSentAtRef.current = now
            setLastAutoSentAt(new Date(now))
            void sendPositionRef.current(active.id, {
              lat: sample.lat,
              lon: sample.lon,
              accuracy_m: sample.accuracy_m,
              speed_kmh: sample.speed_kmh,
              heading_deg: sample.heading_deg,
              altitude_m: sample.altitude_m,
            })
          },
          {
            notificationTitle: 'NodeCloud モビリティ',
            notificationBody: `${myVehicle?.name ?? '車両'} の現在地を送信中`,
            distanceFilter: 5,
          },
        )
        if (cancelled) void handle.clear()
      } catch (err) {
        const geoErr = err as { message?: string }
        console.warn('[MobilityDriverPage] bg watcher start failed', geoErr)
      }
    })()
    return () => {
      cancelled = true
      void handle?.clear()
    }
  }, [autoSend, myActive, myVehicle])

  useEffect(() => {
    let handle: { clear: () => void } | null = null
    let cancelled = false
    void (async () => {
      try {
        handle = await watchSamples(
          (sample, err) => {
            if (err) {
              setLocationError(err.message)
              return
            }
            if (!sample) return
            setCurrentPos([sample.lat, sample.lon])
            setAccuracy(sample.accuracy_m)
            setLocationError(null)

            // 乗車中 + 自動送信 ON なら throttle して送る
            const active = myActiveRef.current
            if (!autoSendRef.current || !active) return
            const now = Date.now()
            if (now - lastSentAtRef.current < PING_INTERVAL_MS) return
            lastSentAtRef.current = now
            setLastAutoSentAt(new Date(now))
            void sendPositionRef.current(active.id, {
              lat: sample.lat,
              lon: sample.lon,
              accuracy_m: sample.accuracy_m,
              speed_kmh: sample.speed_kmh,
              heading_deg: sample.heading_deg,
              altitude_m: sample.altitude_m,
            })
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
        )
        // アンマウント時対策: watch 開始中にアンマウントされていたら即クリア
        if (cancelled) handle.clear()
      } catch (err) {
        const geoErr = err as { message?: string }
        setLocationError(geoErr.message ?? '位置情報の取得に失敗しました')
      }
    })()
    return () => {
      cancelled = true
      handle?.clear()
    }
  }, [])

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
      {/* ヘッダ: NodeCloud ブランド 1 行のみ (組織情報等は載せない) */}
      <div className="px-3 py-2 bg-slate-800 text-white flex items-center gap-2 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="p-1 rounded hover:bg-slate-700 shrink-0"
          title="トップに戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="text-base font-bold flex-1">NodeCloud</div>
        {locationError && (
          <span className="text-[10px] text-amber-300 max-w-[10rem] text-right leading-tight">
            {locationError}
          </span>
        )}
      </div>

      {/* サブヘッダ: 現在の車両状態 (乗車中のときだけ) */}
      {myActive && myVehicle && (
        <div className="px-3 py-1.5 bg-slate-700 text-white flex items-center gap-2 shrink-0 text-xs">
          <Car className="h-4 w-4 text-indigo-300 shrink-0" />
          <span className="font-semibold truncate">{myVehicle.name}</span>
          <span className="text-slate-300 shrink-0">
            · {KIND_LABEL[myVehicle.kind]} · 稼働中
          </span>
        </div>
      )}

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

      {/* 自動送信の直近状態 (デバッグ + フィードバック用) */}
      {myActive && autoSend && (
        <div className="mx-3 mb-1 mt-2 px-2 py-1 text-[10px] rounded bg-emerald-900/40 border border-emerald-700 text-emerald-100 flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          自動送信中 · 最終:{' '}
          {lastAutoSentAt
            ? lastAutoSentAt.toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })
            : '待機'}
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
