// モバイル向け ドライバー中心画面 (/mobility/drive)
//
// 特徴:
//   ・全画面地図がベース
//   ・上部ヘッダに現在の車両/割当情報
//   ・下部に大きな行動ボタン
//       - 割当なし: 「乗車」→ 車両ピッカー
//       - 自分の割当あり: 「自動送信 ON/OFF」トグル + 「降車」
//       - 他人の割当: 読み取り専用 (別画面推奨)
//   ・現在地は Geolocation で自動追跡し watchPosition で連続送信
//     (画面表示中のみ。バックグラウンドは Capacitor 統合で対応)

import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Car,
  ChevronRight,
  Construction,
  Loader2,
  LogOut,
  MapPin,
  Navigation,
  Play,
  Truck,
  X,
} from 'lucide-react'
import L from 'leaflet'
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
} from 'react-leaflet'
import { VehicleMarker } from '@/features/mobility/VehicleMarker'
import 'leaflet/dist/leaflet.css'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { isMobileDevice } from '@/lib/displayMode'
import { watchSamples, watchSamplesInBackground } from '@/lib/geolocation'
import {
  bearingDeg,
  bearingLabel,
  computeTotalDistanceMeters,
  haversineMeters,
} from '@/lib/geoDistance'
import { useMobilityStore } from '@/stores/mobilityStore'
import type {
  MobilityPosition,
  MobilityProject,
  MobilityProjectPoint,
  Vehicle,
  VehicleKind,
} from '@/types/database'

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

// 今日 0 時 (ローカルタイム)
function startOfTodayLocal(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

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
    setAssignmentDestination,
    sendPosition,
    fetchRecentPositions,
    fetchPositionsForUserSince,
    fetchMyAssignedProjects,
    fetchProjectPoints,
  } = useMobilityStore()

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  // 割り当てられた運行現場 (プロジェクト) の一覧
  const [myProjects, setMyProjects] = useState<MobilityProject[]>([])
  useEffect(() => {
    if (!user) {
      setMyProjects([])
      return
    }
    let cancelled = false
    void (async () => {
      const rows = await fetchMyAssignedProjects(user.id)
      if (!cancelled) setMyProjects(rows)
    })()
    return () => {
      cancelled = true
    }
  }, [user, fetchMyAssignedProjects])

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

  // 選択済みの行き先はサーバー (vehicle_assignments.destination_point_id) が正。
  // myActive.destination_point を通じて反映され、管理画面とも共有される。
  const selectedDestination: MobilityProjectPoint | null =
    myActive?.destination_point ?? null

  const [showDestSheet, setShowDestSheet] = useState(false)
  const [destBusy, setDestBusy] = useState(false)
  const [destError, setDestError] = useState<string | null>(null)

  const applyDestination = async (
    point: MobilityProjectPoint | null,
  ): Promise<boolean> => {
    if (!myActive) return false
    setDestBusy(true)
    setDestError(null)
    try {
      const res = await setAssignmentDestination(myActive.id, point?.id ?? null)
      if (!res.ok) {
        setDestError(res.error)
        return false
      }
      return true
    } finally {
      setDestBusy(false)
    }
  }

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
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState<number | null>(null)
  const [currentHeadingDeg, setCurrentHeadingDeg] = useState<number | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [lastAutoSentAt, setLastAutoSentAt] = useState<Date | null>(null)
  const [autoSend, setAutoSend] = useState(false)

  // 本日走行距離 (自分の位置ログを resetAt 以降で累積)
  //   resetAt は localStorage に永続化 (キーは user_id ごと)。既定は今日 00:00 (JST)
  //   ユーザーが「リセット」ボタンを押すと現在時刻に更新される
  const resetKey = user ? `mobility:distanceResetAt:${user.id}` : null
  const [resetAt, setResetAt] = useState<Date>(() => {
    if (typeof window === 'undefined' || !resetKey) return startOfTodayLocal()
    const saved = localStorage.getItem(resetKey)
    if (saved) {
      const d = new Date(saved)
      // 前日以前の保存値なら今日 00:00 にリセット
      if (d.getTime() >= startOfTodayLocal().getTime()) return d
    }
    return startOfTodayLocal()
  })
  const [todayDistanceM, setTodayDistanceM] = useState(0)

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
            setCurrentSpeedKmh(sample.speed_kmh)
            setCurrentHeadingDeg(sample.heading_deg)
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

  // 本日走行距離の計算 (resetAt 以降の自分の全 assignment の位置を対象)
  //   - 送信 (lastAutoSentAt) or リセット時刻 (resetAt) or 乗車状態 (myActive) の
  //     変化で再計算
  //   - myActive がある間は 20 秒ごとにも軽く refresh (バックグラウンドで
  //     ping が増えていくケース)
  useEffect(() => {
    if (!user) {
      setTodayDistanceM(0)
      return
    }
    let cancelled = false
    const compute = async () => {
      const rows = await fetchPositionsForUserSince(user.id, resetAt.toISOString())
      if (cancelled) return
      const m = computeTotalDistanceMeters(rows)
      setTodayDistanceM(m)
    }
    void compute()
    const timer = myActive ? setInterval(compute, 20_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [user, resetAt, myActive, lastAutoSentAt, fetchPositionsForUserSince])

  const handleResetDistance = () => {
    if (!confirm('本日の走行距離をリセットしますか?')) return
    const now = new Date()
    setResetAt(now)
    setTodayDistanceM(0)
    if (resetKey) {
      try {
        localStorage.setItem(resetKey, now.toISOString())
      } catch {
        /* ignore quota errors */
      }
    }
  }

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

  // 手動送信は仕様変更で削除 (自動送信トグルのみで十分)


  const [showPicker, setShowPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyError, setBusyError] = useState<string | null>(null)
  // PC からアクセスしていたら警告を出す (ドライバー画面はモバイル専用)
  const [showPcWarning, setShowPcWarning] = useState(() => !isMobileDevice())

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

  // 目的地までの方位 / 距離
  const destInfo = useMemo(() => {
    if (!currentPos || !selectedDestination) return null
    const from = { lat: currentPos[0], lon: currentPos[1] }
    const to = { lat: selectedDestination.lat, lon: selectedDestination.lon }
    const deg = bearingDeg(from, to)
    const dist = haversineMeters(from, to)
    return {
      deg,
      label: bearingLabel(deg),
      meters: dist,
    }
  }, [currentPos, selectedDestination])

  const destLine = useMemo<[number, number][] | null>(() => {
    if (!currentPos || !selectedDestination) return null
    return [currentPos, [selectedDestination.lat, selectedDestination.lon]]
  }, [currentPos, selectedDestination])

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

      {/* PC 検知警告 (モバイル専用画面である旨) */}
      {showPcWarning && (
        <div className="mx-3 mt-2 p-2 bg-amber-900/40 border border-amber-700 rounded text-[11px] text-amber-100 flex items-start gap-2">
          <span className="shrink-0">⚠</span>
          <span className="flex-1">
            この画面はスマートフォン専用に設計されています。PC から操作するとレイアウトや位置情報が正しく動作しない場合があります。
            管理画面は
            <button
              type="button"
              onClick={() => navigate('/mobility')}
              className="mx-1 underline text-amber-200 hover:text-white"
            >
              /mobility
            </button>
            からご利用ください。
          </span>
          <button
            type="button"
            onClick={() => setShowPcWarning(false)}
            className="shrink-0 px-1.5 text-amber-200 hover:text-white"
            title="警告を閉じる"
          >
            ✕
          </button>
        </div>
      )}

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

      {/* 速度・本日走行距離パネル (乗車中のみ) */}
      {myActive && (
        <div className="mx-3 mt-2 grid grid-cols-2 gap-2 shrink-0">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-white">
            <div className="text-[10px] text-slate-400">現在速度</div>
            <div className="text-2xl font-bold leading-tight">
              {currentSpeedKmh != null && currentSpeedKmh >= 0
                ? Math.round(currentSpeedKmh)
                : '—'}
              <span className="text-xs font-normal text-slate-300 ml-1">km/h</span>
            </div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-white">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400 flex-1">本日走行</span>
              <button
                type="button"
                onClick={handleResetDistance}
                className="text-[9px] text-slate-400 hover:text-white underline"
                title="本日の走行距離をリセット"
              >
                リセット
              </button>
            </div>
            <div className="text-2xl font-bold leading-tight">
              {(todayDistanceM / 1000).toFixed(1)}
              <span className="text-xs font-normal text-slate-300 ml-1">km</span>
            </div>
            <div className="text-[9px] text-slate-500 mt-0.5">
              {resetAt.toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              〜
            </div>
          </div>
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
          {destLine && (
            <Polyline
              positions={destLine}
              pathOptions={{
                color: '#f59e0b',
                weight: 3,
                dashArray: '6 8',
                opacity: 0.9,
              }}
            />
          )}
          {selectedDestination && (
            <Marker
              position={[selectedDestination.lat, selectedDestination.lon]}
              icon={buildDestinationIcon(selectedDestination.name)}
            />
          )}
          {currentPos && (
            <VehicleMarker
              position={currentPos}
              heading={currentHeadingDeg}
              color={myActive ? '#10b981' : '#3b82f6'}
              size={22}
            />
          )}
        </MapContainer>

        {/* 目的地までの方位・距離オーバーレイ */}
        {selectedDestination && destInfo && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[500] bg-slate-900/85 backdrop-blur text-white rounded-lg px-3 py-2 border border-amber-500/60 shadow-lg max-w-[92%]">
            <div className="flex items-center gap-2">
              <div className="relative shrink-0 h-9 w-9 rounded-full bg-amber-500/20 border border-amber-400 flex items-center justify-center">
                <Navigation
                  className="h-5 w-5 text-amber-300"
                  style={{
                    transform: `rotate(${destInfo.deg - (currentHeadingDeg ?? 0)}deg)`,
                    transition: 'transform 250ms',
                  }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-amber-200 truncate">
                  目的地: {selectedDestination.name}
                </div>
                <div className="text-sm font-bold leading-tight">
                  {destInfo.label} ({Math.round(destInfo.deg)}°)
                  <span className="ml-2 text-amber-200">
                    {formatDistance(destInfo.meters)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void applyDestination(null)}
                disabled={destBusy}
                className="shrink-0 h-7 w-7 rounded hover:bg-slate-700 flex items-center justify-center disabled:opacity-50"
                title="行き先を解除"
              >
                {destBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        )}
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
      <div className="p-3 bg-slate-800 flex flex-col gap-2 shrink-0">
        {myActive ? (
          <>
            <div className="flex gap-2">
              {/* 自動送信トグル: メインの大ボタン */}
              <button
                onClick={() => setAutoSend((v) => !v)}
                disabled={busy}
                role="switch"
                aria-checked={autoSend}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-base font-semibold rounded-lg transition ${
                  autoSend
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                }`}
                title={autoSend ? 'タップで自動送信を停止' : 'タップで自動送信を開始'}
              >
                <span
                  className={`inline-block h-4 w-8 rounded-full relative ${
                    autoSend ? 'bg-emerald-300' : 'bg-slate-500'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                      autoSend ? 'left-4' : 'left-0.5'
                    }`}
                  />
                </span>
                自動送信 {autoSend ? 'ON' : 'OFF'}
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
            </div>
            {/* 行き先ピッカー起動ボタン (割当あり中のみ) */}
            <button
              type="button"
              onClick={() => setShowDestSheet(true)}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-amber-500 text-amber-200 hover:bg-amber-950/40 disabled:opacity-50"
            >
              <MapPin className="h-4 w-4" />
              {selectedDestination
                ? `行き先: ${selectedDestination.name} を変更`
                : '行き先を選ぶ'}
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

      {showDestSheet && (
        <DestinationPickerSheet
          projects={myProjects}
          currentPos={currentPos}
          fetchProjectPoints={fetchProjectPoints}
          busy={destBusy}
          error={destError}
          onConfirm={async (point) => {
            const ok = await applyDestination(point)
            if (ok) setShowDestSheet(false)
          }}
          onClear={async () => {
            const ok = await applyDestination(null)
            if (ok) setShowDestSheet(false)
          }}
          onClose={() => setShowDestSheet(false)}
        />
      )}
    </div>
  )
}

// 目的地 (ピン) の Leaflet アイコン。名称を吹き出しに表示。
function buildDestinationIcon(name: string): L.DivIcon {
  const safe = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const html = `
    <div style="position:relative;transform:translate(-50%,-100%);pointer-events:none;">
      <div style="background:#f59e0b;color:#111827;font-size:11px;font-weight:600;padding:2px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.4);max-width:160px;overflow:hidden;text-overflow:ellipsis;">${safe}</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #f59e0b;margin:0 auto;"></div>
    </div>`
  return L.divIcon({
    className: 'mobility-destination-icon',
    html,
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  })
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`
}

// -----------------------------------------------------------------------------
// 行き先ピッカー (3 ステップ: プロジェクト → ポイント → プレビュー → 確定)
// -----------------------------------------------------------------------------
function DestinationPickerSheet({
  projects,
  currentPos,
  fetchProjectPoints,
  busy,
  error,
  onConfirm,
  onClear,
  onClose,
}: {
  projects: MobilityProject[]
  currentPos: [number, number] | null
  fetchProjectPoints: (projectId: string) => Promise<MobilityProjectPoint[]>
  busy: boolean
  error: string | null
  onConfirm: (point: MobilityProjectPoint) => void | Promise<void>
  onClear: () => void | Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState<'projects' | 'points' | 'preview'>('projects')
  const [selectedProject, setSelectedProject] = useState<MobilityProject | null>(null)
  const [points, setPoints] = useState<MobilityProjectPoint[]>([])
  const [loadingPoints, setLoadingPoints] = useState(false)
  const [pointsError, setPointsError] = useState<string | null>(null)
  const [previewPoint, setPreviewPoint] = useState<MobilityProjectPoint | null>(null)

  const openProject = (project: MobilityProject) => {
    setSelectedProject(project)
    setStep('points')
    setPoints([])
    setPointsError(null)
    setLoadingPoints(true)
    void (async () => {
      try {
        const rows = await fetchProjectPoints(project.id)
        setPoints(rows.filter((p) => p.active))
      } catch (err) {
        setPointsError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingPoints(false)
      }
    })()
  }

  const openPreview = (point: MobilityProjectPoint) => {
    setPreviewPoint(point)
    setStep('preview')
  }

  const goBack = () => {
    if (step === 'preview') {
      setStep('points')
      setPreviewPoint(null)
    } else if (step === 'points') {
      setStep('projects')
      setSelectedProject(null)
      setPoints([])
    }
  }

  const previewInfo = useMemo(() => {
    if (!currentPos || !previewPoint) return null
    const from = { lat: currentPos[0], lon: currentPos[1] }
    const to = { lat: previewPoint.lat, lon: previewPoint.lon }
    const deg = bearingDeg(from, to)
    return {
      deg,
      label: bearingLabel(deg),
      meters: haversineMeters(from, to),
    }
  }, [currentPos, previewPoint])

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end z-[9999]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full rounded-t-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b flex items-center gap-2">
          {step !== 'projects' && (
            <button
              type="button"
              onClick={goBack}
              className="p-1 rounded hover:bg-slate-100"
              title="戻る"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <h3 className="text-base font-semibold flex-1 truncate">
            {step === 'projects' && '運行現場を選ぶ'}
            {step === 'points' && (selectedProject?.name ?? 'ポイントを選ぶ')}
            {step === 'preview' && (previewPoint?.name ?? '行き先を確認')}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {step === 'projects' && (
            <>
              {projects.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-400">
                  割り当てられた運行現場がありません
                </div>
              ) : (
                <ul className="divide-y">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => openProject(p)}
                        className="w-full flex items-center gap-3 p-4 text-left active:bg-indigo-50"
                      >
                        <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                          <MapPin className="h-4 w-4 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {p.name}
                          </div>
                          {p.description && (
                            <div className="text-[11px] text-slate-500 truncate">
                              {p.description}
                            </div>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 'points' && (
            <>
              {loadingPoints ? (
                <div className="p-6 flex justify-center text-slate-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : pointsError ? (
                <div className="p-4 text-xs text-red-600">
                  ポイントの取得に失敗: {pointsError}
                </div>
              ) : points.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-400">
                  この現場にはポイントが登録されていません
                </div>
              ) : (
                <ul className="divide-y">
                  {points.map((pt) => {
                    const dist =
                      currentPos != null
                        ? haversineMeters(
                            { lat: currentPos[0], lon: currentPos[1] },
                            { lat: pt.lat, lon: pt.lon },
                          )
                        : null
                    return (
                      <li key={pt.id}>
                        <button
                          type="button"
                          onClick={() => openPreview(pt)}
                          className="w-full flex items-center gap-3 p-4 text-left active:bg-amber-50"
                        >
                          <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                            <MapPin className="h-4 w-4 text-amber-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold truncate">
                              {pt.name}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {pt.kind && <span className="mr-2">{pt.kind}</span>}
                              {dist != null && <span>{formatDistance(dist)}</span>}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}

          {step === 'preview' && previewPoint && (
            <div className="flex flex-col">
              <div className="h-64 w-full">
                <MapContainer
                  center={[previewPoint.lat, previewPoint.lon]}
                  zoom={15}
                  className="h-full w-full"
                  scrollWheelZoom={false}
                >
                  <TileLayer
                    attribution='&copy; OpenStreetMap'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <Marker
                    position={[previewPoint.lat, previewPoint.lon]}
                    icon={buildDestinationIcon(previewPoint.name)}
                  />
                  {currentPos && (
                    <>
                      <Polyline
                        positions={[
                          currentPos,
                          [previewPoint.lat, previewPoint.lon],
                        ]}
                        pathOptions={{
                          color: '#f59e0b',
                          weight: 3,
                          dashArray: '6 8',
                        }}
                      />
                      <VehicleMarker
                        position={currentPos}
                        heading={null}
                        color="#10b981"
                        size={18}
                      />
                    </>
                  )}
                </MapContainer>
              </div>
              <div className="p-4 space-y-2">
                <div className="text-base font-semibold">{previewPoint.name}</div>
                {previewPoint.kind && (
                  <div className="text-xs text-slate-500">
                    種別: {previewPoint.kind}
                  </div>
                )}
                {previewPoint.memo && (
                  <div className="text-xs text-slate-600 whitespace-pre-wrap">
                    {previewPoint.memo}
                  </div>
                )}
                {previewInfo && (
                  <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-sm">
                    <div className="font-semibold text-amber-900">
                      現在地から {previewInfo.label} ({Math.round(previewInfo.deg)}°)
                    </div>
                    <div className="text-amber-800">
                      距離 (直線): {formatDistance(previewInfo.meters)}
                    </div>
                  </div>
                )}
                {!currentPos && (
                  <div className="mt-2 text-[11px] text-slate-400">
                    現在地未取得のため距離・方向は計算できません。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {step === 'preview' && previewPoint && (
          <div className="p-3 border-t space-y-2">
            {error && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClear}
                disabled={busy}
                className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded disabled:opacity-50"
              >
                行き先を解除
              </button>
              <button
                type="button"
                onClick={() => onConfirm(previewPoint)}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-amber-500 text-white font-semibold rounded hover:bg-amber-600 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Navigation className="h-4 w-4" />
                )}
                この行き先で確定
              </button>
            </div>
          </div>
        )}
      </div>
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
