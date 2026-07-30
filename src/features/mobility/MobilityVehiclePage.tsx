// 個別車両の詳細画面。
//
// URL: /mobility/vehicles/:vehicleId
//
// 表示:
//   ・車両基本情報 (編集ボタンで MobilityHomePage と同じダイアログ)
//   ・現在の割当 (稼働中なら終了ボタン)
//   ・割当開始ボタン (自分 or 組織メンバー選択)
//   ・割当履歴 (最大 100 件)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Car,
  Construction,
  Loader2,
  MapPin,
  PlayCircle,
  Send,
  StopCircle,
  Truck,
  User,
  UserPlus,
  X,
} from 'lucide-react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { getCurrentSample } from '@/lib/geolocation'
import { computeTotalDistanceMeters } from '@/lib/geoDistance'
import { useMobilityStore, type AssignmentWithNames } from '@/stores/mobilityStore'
import type { MobilityPosition, VehicleKind } from '@/types/database'

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

interface OrgMemberRow {
  user_id: string
  email: string
  full_name: string | null
  role: 'admin' | 'member'
}

// list_org_members RPC (型なし)
async function fetchOrgMembers(orgId: string): Promise<OrgMemberRow[]> {
  const { data, error } = (await supabase.rpc(
    'list_org_members' as never,
    { p_org_id: orgId } as never,
  )) as unknown as { data: OrgMemberRow[] | null; error: { message: string } | null }
  if (error) {
    console.warn('[MobilityVehiclePage] fetchOrgMembers failed', error)
    return []
  }
  return data ?? []
}

export function MobilityVehiclePage() {
  const { vehicleId } = useParams<{ vehicleId: string }>()
  const navigate = useNavigate()
  const canUse = useCanUseMobility()
  const { user, profile } = useAuth()

  const {
    vehicles,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    fetchAssignmentHistory,
    startAssignment,
    endAssignment,
    sendPosition,
    fetchRecentPositions,
    fetchPositionsForVehicleSince,
  } = useMobilityStore()

  const vehicle = useMemo(
    () => vehicles.find((v) => v.id === vehicleId) ?? null,
    [vehicles, vehicleId],
  )

  const [history, setHistory] = useState<AssignmentWithNames[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busy, setBusy] = useState<'start' | 'end' | 'ping' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDriverPicker, setShowDriverPicker] = useState(false)
  const [recentPositions, setRecentPositions] = useState<MobilityPosition[]>([])
  const [lastPingInfo, setLastPingInfo] = useState<string | null>(null)
  // 地図に描画する assignment の ID。null なら「稼働中割当」or「履歴最新」を自動選択
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null)
  const [trackPositions, setTrackPositions] = useState<MobilityPosition[]>([])
  const [trackLoading, setTrackLoading] = useState(false)
  // 本日の位置ログ (この車両分)。速度・走行距離集計に使う
  const [todayPositions, setTodayPositions] = useState<MobilityPosition[]>([])

  const active = vehicleId ? activeAssignments.get(vehicleId) ?? null : null
  const isSelfActive = active?.user_id === user?.id
  const canSendPing = !!active && isSelfActive

  const refetchPositions = useCallback(async () => {
    if (!active) {
      setRecentPositions([])
      return
    }
    const rows = await fetchRecentPositions(active.id, 20)
    setRecentPositions(rows)
  }, [active, fetchRecentPositions])

  useEffect(() => {
    void refetchPositions()
  }, [refetchPositions])

  const refetchHistory = useCallback(async () => {
    if (!vehicleId) return
    setHistoryLoading(true)
    try {
      const rows = await fetchAssignmentHistory(vehicleId)
      setHistory(rows)
    } finally {
      setHistoryLoading(false)
    }
  }, [vehicleId, fetchAssignmentHistory])

  useEffect(() => {
    if (!vehicle && vehicles.length === 0 && vehicleId) {
      // 直リンクで来た時: vehicles を空 → まず org 側から fetch する必要あり。
      // organization_id 不明なので、ここでは何もせず、Home 側 useEffect の後に
      // vehicles が入るのを待つ。もし来ないなら Home に戻す判断は下記で。
    }
    void refetchHistory()
  }, [vehicle, vehicles.length, vehicleId, refetchHistory])

  // 直リンク or リロード時: vehicles が空なら組織 ID を profile から拾って fetch
  useEffect(() => {
    const orgId = profile?.organization_id
    if (!orgId || vehicles.length > 0) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [profile?.organization_id, vehicles.length, fetchVehicles, fetchActiveAssignments])

  // 地図に描く対象の解決:
  //   selectedAssignmentId が指定されていればそれ、
  //   さもなくば稼働中割当、それも無ければ履歴の最新
  const effectiveAssignmentId = useMemo(() => {
    if (selectedAssignmentId) return selectedAssignmentId
    if (active) return active.id
    if (history.length > 0) return history[0].id
    return null
  }, [selectedAssignmentId, active, history])

  // 描画対象 assignment の情報 (ラベル用)
  const effectiveAssignment = useMemo<AssignmentWithNames | null>(() => {
    if (!effectiveAssignmentId) return null
    if (active?.id === effectiveAssignmentId) return active
    return history.find((h) => h.id === effectiveAssignmentId) ?? null
  }, [effectiveAssignmentId, active, history])

  // 軌跡ロード。recentPositions.length を依存に含めることで
  // 「現在の割当にピングを送るたびに地図側も自動更新」される。
  useEffect(() => {
    if (!effectiveAssignmentId) {
      setTrackPositions([])
      return
    }
    let cancelled = false
    setTrackLoading(true)
    ;(async () => {
      const rows = await fetchRecentPositions(effectiveAssignmentId, 500)
      if (!cancelled) {
        // recorded_at DESC で返る → polyline に流し込むため昇順に反転
        setTrackPositions(rows.slice().reverse())
        setTrackLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [effectiveAssignmentId, fetchRecentPositions, recentPositions.length])

  // 本日 (ローカル 00:00〜) の位置ログをこの車両分だけまとめて取る。
  //   速度・走行距離集計と、履歴行の per-assignment 距離バッジに使う。
  //   稼働中は 20 秒毎に軽く refresh。
  useEffect(() => {
    if (!vehicleId) return
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const sinceIso = startOfToday.toISOString()
    let cancelled = false
    const load = async () => {
      const rows = await fetchPositionsForVehicleSince(vehicleId, sinceIso)
      if (!cancelled) setTodayPositions(rows)
    }
    void load()
    const timer = active ? setInterval(load, 20_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [vehicleId, active, fetchPositionsForVehicleSince])

  // 本日ポジションを assignment_id ごとにグループ化
  const todayByAssignment = useMemo(() => {
    const map = new Map<string, MobilityPosition[]>()
    for (const p of todayPositions) {
      const arr = map.get(p.assignment_id)
      if (arr) arr.push(p)
      else map.set(p.assignment_id, [p])
    }
    return map
  }, [todayPositions])

  // 本日この車両の合計走行距離 (メートル)
  const todayVehicleDistanceM = useMemo(() => {
    let total = 0
    for (const rows of todayByAssignment.values()) {
      total += computeTotalDistanceMeters(rows)
    }
    return total
  }, [todayByAssignment])

  // 稼働中割当の最新位置から現在速度 (km/h)
  const currentSpeedKmh = useMemo(() => {
    if (!active) return null
    const rows = todayByAssignment.get(active.id)
    if (!rows || rows.length === 0) return null
    // fetchPositionsForVehicleSince は昇順で返るので末尾が最新
    const last = rows[rows.length - 1]
    return last.speed_kmh
  }, [active, todayByAssignment])

  if (!canUse) return <Navigate to="/" replace />
  if (!vehicleId) return <Navigate to="/mobility" replace />

  const Icon = vehicle ? KIND_ICON[vehicle.kind] : Car

  const handleStartSelf = async () => {
    if (!vehicle) return
    setError(null)
    setBusy('start')
    try {
      const res = await startAssignment(vehicle.id)
      if (!res) throw new Error(useMobilityStore.getState().vehiclesError ?? '開始に失敗しました')
      await refetchHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleEnd = async () => {
    if (!active) return
    if (!confirm(`「${vehicle?.name}」の割当を終了しますか?`)) return
    setError(null)
    setBusy('end')
    try {
      await endAssignment(active.id)
      await refetchHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // ブラウザ Geolocation で現在地を取り、mobility_positions に 1 件 INSERT。
  //   本番モバイル (Capacitor) では別 API 経由になるが、Web でも同じ RLS を通る形で
  //   動作確認できる。
  const handleSendPing = async () => {
    if (!active) return
    setError(null)
    setBusy('ping')
    try {
      const sample = await getCurrentSample({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      })
      const res = await sendPosition(active.id, {
        lat: sample.lat,
        lon: sample.lon,
        accuracy_m: sample.accuracy_m,
        speed_kmh: sample.speed_kmh,
        heading_deg: sample.heading_deg,
        altitude_m: sample.altitude_m,
      })
      if (!res.ok) throw new Error(res.error)
      setLastPingInfo(
        `${sample.lat.toFixed(6)}, ${sample.lon.toFixed(6)}${
          sample.accuracy_m != null ? ` (±${Math.round(sample.accuracy_m)}m)` : ''
        }`,
      )
      await refetchPositions()
    } catch (err) {
      const anyErr = err as { message?: string }
      setError(anyErr.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleStartOther = async (driverUserId: string) => {
    if (!vehicle) return
    setError(null)
    setBusy('start')
    setShowDriverPicker(false)
    try {
      const res = await startAssignment(vehicle.id, driverUserId)
      if (!res) throw new Error(useMobilityStore.getState().vehiclesError ?? '開始に失敗しました')
      await refetchHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

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
        <Icon className="h-5 w-5 text-indigo-600" />
        <h1 className="text-lg font-bold truncate flex-1">
          {vehicle?.name ?? '(読み込み中)'}
        </h1>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-5">
        {!vehicle ? (
          <div className="text-center py-8 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
            車両情報を読み込み中...
          </div>
        ) : (
          <>
            {/* 基本情報 */}
            <section className="bg-white rounded-lg border p-4">
              <div className="grid grid-cols-[8rem_1fr] gap-y-2 gap-x-2 text-sm">
                <div className="text-slate-500">車両名</div>
                <div className="font-medium">{vehicle.name}</div>
                <div className="text-slate-500">ナンバー/機械番号</div>
                <div>{vehicle.plate_or_serial || '—'}</div>
                <div className="text-slate-500">種別</div>
                <div>{KIND_LABEL[vehicle.kind]}</div>
                <div className="text-slate-500">稼働状態</div>
                <div>
                  {vehicle.active ? (
                    <span className="text-emerald-700">稼働中の車両</span>
                  ) : (
                    <span className="text-slate-400">廃止済み</span>
                  )}
                </div>
                {vehicle.memo && (
                  <>
                    <div className="text-slate-500">メモ</div>
                    <div className="whitespace-pre-wrap">{vehicle.memo}</div>
                  </>
                )}
              </div>
            </section>

            {/* 速度・本日走行距離パネル */}
            <section className="grid grid-cols-2 gap-2">
              <div className="p-3 bg-white rounded-lg border">
                <div className="text-[10px] text-slate-500">現在速度</div>
                <div className="text-2xl font-bold leading-tight text-slate-800">
                  {active && currentSpeedKmh != null && currentSpeedKmh >= 0
                    ? Math.round(currentSpeedKmh)
                    : '—'}
                  <span className="text-xs font-normal text-slate-500 ml-1">km/h</span>
                </div>
                {!active && (
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    稼働中の割当なし
                  </div>
                )}
              </div>
              <div className="p-3 bg-white rounded-lg border">
                <div className="text-[10px] text-slate-500">本日走行 (この車両)</div>
                <div className="text-2xl font-bold leading-tight text-slate-800">
                  {(todayVehicleDistanceM / 1000).toFixed(1)}
                  <span className="text-xs font-normal text-slate-500 ml-1">km</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  00:00 〜 · 今日の全ドライバー合計
                </div>
              </div>
            </section>

            {/* 現在の割当 */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1 h-5 rounded bg-emerald-500" />
                <h2 className="text-sm font-semibold text-slate-700">現在の割当</h2>
              </div>
              {active ? (
                <div className="p-3 bg-white rounded border flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                    <User className="h-4 w-4 text-emerald-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {active.driver_name || '(名前未設定)'}
                      {active.user_id === user?.id && (
                        <span className="ml-1.5 text-[10px] text-indigo-600">(自分)</span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      開始:{' '}
                      {new Date(active.started_at).toLocaleString('ja-JP', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                  {(active.user_id === user?.id || true) && (
                    <button
                      type="button"
                      onClick={handleEnd}
                      disabled={busy === 'end'}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                    >
                      {busy === 'end' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <StopCircle className="h-3.5 w-3.5" />
                      )}
                      終了
                    </button>
                  )}
                </div>
              ) : (
                <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                  現在この車両に乗っているドライバーはいません
                </div>
              )}

              {!active && vehicle.active && (
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleStartSelf}
                    disabled={busy === 'start'}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {busy === 'start' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlayCircle className="h-4 w-4" />
                    )}
                    自分が乗車
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDriverPicker(true)}
                    disabled={busy === 'start'}
                    className="flex items-center gap-1 px-3 py-2 text-sm border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-50"
                    title="別のドライバーを割り当てる"
                  >
                    <UserPlus className="h-4 w-4" />
                  </button>
                </div>
              )}
            </section>

            {/* 走行軌跡地図 (現在の割当 or 履歴選択の polyline) */}
            {effectiveAssignmentId && (
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-1 h-5 rounded bg-indigo-500" />
                  <h2 className="text-sm font-semibold text-slate-700 flex-1">
                    走行軌跡
                    {effectiveAssignment && (
                      <span className="text-slate-500 text-xs ml-2 font-normal">
                        {effectiveAssignment.driver_name || '(名前未設定)'} ·{' '}
                        {new Date(effectiveAssignment.started_at).toLocaleString(
                          'ja-JP',
                          {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          },
                        )}
                        {!effectiveAssignment.ended_at && (
                          <span className="ml-1 text-emerald-600">(稼働中)</span>
                        )}
                      </span>
                    )}
                  </h2>
                  {trackLoading && (
                    <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />
                  )}
                  {selectedAssignmentId && (
                    <button
                      type="button"
                      onClick={() => setSelectedAssignmentId(null)}
                      className="text-[10px] text-slate-500 hover:text-slate-700 underline"
                      title="表示中の履歴選択を解除して稼働中/最新に戻す"
                    >
                      解除
                    </button>
                  )}
                </div>
                <div
                  className="rounded border overflow-hidden bg-slate-100"
                  style={{ height: 320 }}
                >
                  {trackPositions.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-slate-400">
                      この割当には位置ログがありません
                    </div>
                  ) : (
                    <TrackMap positions={trackPositions} />
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-1 pl-3">
                  {trackPositions.length} 点表示 · 履歴の行をクリックすると別の割当を表示できます
                </div>
              </section>
            )}

            {/* 位置情報 (乗車中の本人のみ送信ボタンが出る) */}
            {active && (
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-1 h-5 rounded bg-sky-500" />
                  <h2 className="text-sm font-semibold text-slate-700 flex-1">
                    位置情報 ({recentPositions.length})
                  </h2>
                  {canSendPing && (
                    <button
                      type="button"
                      onClick={handleSendPing}
                      disabled={busy === 'ping'}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50"
                      title="ブラウザの位置情報を 1 件送信 (テスト用)"
                    >
                      {busy === 'ping' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      現在地を送信
                    </button>
                  )}
                </div>
                {!canSendPing && (
                  <div className="text-[11px] text-slate-500 mb-1.5 pl-3">
                    現在この車両を運転しているのは自分ではないため、送信ボタンは表示されません。
                  </div>
                )}
                {lastPingInfo && (
                  <div className="mb-1.5 p-2 bg-sky-50 border border-sky-200 rounded text-[11px] text-sky-700">
                    ✓ 送信しました: {lastPingInfo}
                  </div>
                )}
                {recentPositions.length === 0 ? (
                  <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                    まだ位置ログはありません
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {recentPositions.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center gap-2 p-2 bg-white rounded border text-[11px]"
                      >
                        <MapPin className="h-3 w-3 text-sky-500 shrink-0" />
                        <span className="flex-1 min-w-0 font-mono truncate">
                          {p.lat.toFixed(6)}, {p.lon.toFixed(6)}
                        </span>
                        {p.accuracy_m != null && (
                          <span className="shrink-0 text-slate-400">
                            ±{Math.round(p.accuracy_m)}m
                          </span>
                        )}
                        {p.speed_kmh != null && p.speed_kmh > 0 && (
                          <span className="shrink-0 text-slate-500">
                            {Math.round(p.speed_kmh)}km/h
                          </span>
                        )}
                        <span className="shrink-0 text-slate-500 w-16 text-right">
                          {new Date(p.recorded_at).toLocaleTimeString('ja-JP', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* 履歴 */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1 h-5 rounded bg-slate-400" />
                <h2 className="text-sm font-semibold text-slate-700 flex-1">
                  割当履歴 ({history.length})
                </h2>
                {historyLoading && (
                  <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />
                )}
              </div>
              {history.length === 0 && !historyLoading ? (
                <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                  履歴はありません
                </div>
              ) : (
                <ul className="space-y-1">
                  {history.map((a) => {
                    const durationMs = a.ended_at
                      ? new Date(a.ended_at).getTime() -
                        new Date(a.started_at).getTime()
                      : Date.now() - new Date(a.started_at).getTime()
                    const hours = Math.floor(durationMs / (60 * 60 * 1000))
                    const mins = Math.floor(
                      (durationMs % (60 * 60 * 1000)) / (60 * 1000),
                    )
                    const isSelected = a.id === effectiveAssignmentId
                    // 本日分の位置ログがあるならここから距離を計算 (過去日の割当は '—')
                    const rowsToday = todayByAssignment.get(a.id)
                    const distanceKm = rowsToday
                      ? computeTotalDistanceMeters(rowsToday) / 1000
                      : null
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedAssignmentId(a.id)}
                          className={`w-full flex items-center gap-2 p-2 bg-white rounded border text-xs text-left hover:border-indigo-400 ${
                            isSelected ? 'ring-1 ring-indigo-500 border-indigo-400' : ''
                          }`}
                          title="この割当の走行軌跡を上の地図に表示"
                        >
                          <User className="h-3 w-3 text-slate-400 shrink-0" />
                          <span className="flex-1 min-w-0 truncate">
                            {a.driver_name || a.user_id.slice(0, 8)}
                          </span>
                          <span className="text-slate-500 shrink-0">
                            {new Date(a.started_at).toLocaleString('ja-JP', {
                              month: '2-digit',
                              day: '2-digit',
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
                          <span
                            className="text-slate-500 shrink-0 w-14 text-right font-medium"
                            title={
                              distanceKm != null
                                ? '本日ログから計算した走行距離'
                                : '本日以外の割当のため距離は非表示'
                            }
                          >
                            {distanceKm != null ? `${distanceKm.toFixed(1)} km` : '—'}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      {showDriverPicker && vehicle && (
        <DriverPickerDialog
          organizationId={vehicle.organization_id}
          onPick={handleStartOther}
          onClose={() => setShowDriverPicker(false)}
        />
      )}
    </div>
  )
}

// 組織メンバーからドライバーを 1 人選ぶダイアログ (admin 想定)
// 走行軌跡地図: positions は昇順 (古い→新しい) で渡される想定。
// polyline を描画し、開始/最新点にマーカー、地図領域を自動フィット。
function TrackMap({ positions }: { positions: MobilityPosition[] }) {
  const line = useMemo(
    () => positions.map((p) => [p.lat, p.lon] as [number, number]),
    [positions],
  )
  const start = positions[0]
  const end = positions[positions.length - 1]
  const isLive = end && !end.recorded_at ? false : true // 全部レコード済みは常に true; live 表示は呼び出し側で判断
  return (
    <MapContainer
      center={start ? [start.lat, start.lon] : [35.681236, 139.767125]}
      zoom={15}
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <AutoFitTrack positions={line} />
      {line.length > 1 && (
        <Polyline positions={line} pathOptions={{ color: '#6366f1', weight: 4 }} />
      )}
      {start && (
        <CircleMarker
          center={[start.lat, start.lon]}
          radius={7}
          pathOptions={{
            color: '#ffffff',
            fillColor: '#22c55e',
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            開始 · {new Date(start.recorded_at).toLocaleTimeString('ja-JP')}
          </Tooltip>
        </CircleMarker>
      )}
      {end && end.id !== start?.id && (
        <CircleMarker
          center={[end.lat, end.lon]}
          radius={8}
          pathOptions={{
            color: '#ffffff',
            fillColor: isLive ? '#ef4444' : '#64748b',
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            最新 · {new Date(end.recorded_at).toLocaleTimeString('ja-JP')}
          </Tooltip>
        </CircleMarker>
      )}
    </MapContainer>
  )
}

// 初回表示時に polyline 全体が収まるように fitBounds
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
    // positions が変化する = 別割当を選び直した/軌跡が伸びた の両方あるが、
    // 伸びた場合に毎回 fitBounds し直すと拡大表示中でも縮小してしまう。
    // → 「点数が大きく変わった (2 倍以上) 場合だけ再フィット」等の工夫は後日
  }, [positions, map])
  return null
}

function DriverPickerDialog({
  organizationId,
  onPick,
  onClose,
}: {
  organizationId: string
  onPick: (userId: string) => void
  onClose: () => void
}) {
  const [members, setMembers] = useState<OrgMemberRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const rows = await fetchOrgMembers(organizationId)
      if (!cancelled) {
        setMembers(rows)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [organizationId])

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">ドライバーを選択</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-2 overflow-y-auto flex-1">
          {loading ? (
            <div className="p-4 text-center text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
              読み込み中...
            </div>
          ) : members.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400">
              メンバーがいません
            </div>
          ) : (
            <ul className="divide-y">
              {members.map((m) => (
                <li key={m.user_id}>
                  <button
                    type="button"
                    onClick={() => onPick(m.user_id)}
                    className="w-full flex items-center gap-2 p-3 text-left hover:bg-indigo-50"
                  >
                    <User className="h-4 w-4 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {m.full_name || m.email}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {m.email}
                      </div>
                    </div>
                    {m.role === 'admin' && (
                      <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">
                        管理者
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
