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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  History,
  Car,
  ChevronRight,
  Compass,
  Construction,
  Crosshair,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  Minus,
  Navigation,
  Play,
  Plus,
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
import { SPEED_BANDS, speedSegments } from '@/features/mobility/FleetMapView'
import 'leaflet/dist/leaflet.css'
// leaflet-rotate は L.Map に rotate/setBearing を注入する副作用 import。
// ヘディングアップ用に必要 (MobileStakingPage が既に import 済みだが、直接
// このページを開いても動くよう明示的に import しておく)。
import 'leaflet-rotate'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { isMobileDevice } from '@/lib/displayMode'
import { watchSamples, watchSamplesInBackground } from '@/lib/geolocation'
import { isMobilityApp } from '@/lib/appVariant'
import {
  enqueuePing,
  flushQueue,
  getQueueLength,
} from '@/lib/mobilityOfflineQueue'
import {
  bearingDeg,
  bearingLabel,
  computeTotalDistanceMeters,
  haversineMeters,
} from '@/lib/geoDistance'
import { useMobilityStore } from '@/stores/mobilityStore'
import { useMobilityMessagesStore } from '@/stores/mobilityMessagesStore'
import { MobilityChatPanel } from '@/features/mobility/MobilityChatPanel'
import { supabase } from '@/lib/supabase'
import type {
  MobilityPosition,
  MobilityProject,
  MobilityProjectPoint,
  Vehicle,
  VehicleAssignment,
  VehicleKind,
} from '@/types/database'
import type { AssignmentWithNames } from '@/stores/mobilityStore'

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

// 現在地追跡: followMe=true の間は pos が変わる度に自車を画面中央に維持。
// programmatic な setView は「ユーザー操作 pan/zoom」と区別するため、直後に
// ignore フラグを立てて MapUserGestureWatcher の追跡 OFF を抑止する。
function FollowMe({
  pos,
  followMe,
  onProgrammaticMove,
}: {
  pos: [number, number] | null
  followMe: boolean
  onProgrammaticMove: () => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!followMe || !pos) return
    onProgrammaticMove()
    map.setView(pos, Math.max(map.getZoom(), 15), { animate: true })
  }, [pos, followMe, map, onProgrammaticMove])
  return null
}

// ユーザーが地図をドラッグしたら追跡を OFF にする。zoom は追跡と両立するので
// 触らない (ズーム後もセンタリングは続く)。
function MapUserGestureWatcher({
  onUserPan,
}: {
  onUserPan: () => void
}) {
  const map = useMap()
  useEffect(() => {
    const handler = () => onUserPan()
    map.on('dragstart', handler)
    return () => {
      map.off('dragstart', handler)
    }
  }, [map, onUserPan])
  return null
}

// leaflet-rotate の bearing を車両ヘディングに追従させる。
// enabled=false の時は 0 (北向き) に戻す。
function MapBearingUpdater({
  enabled,
  heading,
}: {
  enabled: boolean
  heading: number | null
}) {
  const map = useMap() as L.Map & {
    setBearing?: (deg: number) => void
  }
  useEffect(() => {
    if (typeof map.setBearing !== 'function') return
    const desired = enabled && heading != null ? -heading : 0
    try {
      map.setBearing(desired)
    } catch {
      /* ignore */
    }
  }, [map, enabled, heading])
  return null
}

// 現在地/ヘディング/ズームのカスタムコントロール (Leaflet 既定を差し替える)
function MapControlStack({
  followMe,
  headingUp,
  onToggleFollow,
  onToggleHeading,
}: {
  followMe: boolean
  headingUp: boolean
  onToggleFollow: () => void
  onToggleHeading: () => void
}) {
  const map = useMap()
  // 「基本」と「アクティブ」の bg/text/border を一切重複させない
  // (以前は `bg-white text-slate-700 ... + bg-emerald-500 text-white` と重ねていて
  //  Tailwind の CSS 出力順で bg-white が勝ち、アクティブ時に白背景+白アイコン=見えない
  //  という状態になっていた)
  const btnBase = 'w-9 h-9 flex items-center justify-center shadow border'
  const btnInactive = 'bg-white text-slate-700 border-slate-300'
  const btnFollowActive = 'bg-emerald-500 text-white border-emerald-600'
  const btnHeadingActive = 'bg-indigo-500 text-white border-indigo-600'
  return (
    <div className="absolute top-3 left-3 z-[500] flex flex-col rounded overflow-hidden">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleFollow()
        }}
        className={`${btnBase} rounded-t ${followMe ? btnFollowActive : btnInactive}`}
        title={followMe ? '追跡中 (タップで停止)' : '自車を追跡'}
      >
        <Crosshair className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleHeading()
        }}
        className={`${btnBase} -mt-px ${headingUp ? btnHeadingActive : btnInactive}`}
        title={headingUp ? 'ヘディングアップ中 (タップで北向き)' : '北向き (タップでヘディングアップ)'}
      >
        <Compass className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          map.zoomIn()
        }}
        className={`${btnBase} -mt-px ${btnInactive}`}
        title="拡大"
      >
        <Plus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          map.zoomOut()
        }}
        className={`${btnBase} -mt-px rounded-b ${btnInactive}`}
        title="縮小"
      >
        <Minus className="h-4 w-4" />
      </button>
    </div>
  )
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
    fetchUserAssignmentHistory,
    fetchMyAssignedProjects,
    fetchProjectPoints,
  } = useMobilityStore()

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  // vehicle_assignments の変化を Realtime + 30秒 polling で追う。
  // 管理者による強制降車 / instruction confirm RPC で新 assignment が作られた場合、
  // 端末側の myActive が古いままだと ping が古い closed assignment に向けて
  // POST され、RLS 42501 で silent drop される (queue の terminal-error 処理)。
  // ここで随時 fetchActiveAssignments を叩いておくことで、次の tick から
  // 正しい assignment_id で送れるようにする。
  useEffect(() => {
    if (!orgId) return
    const channel = supabase
      .channel(`vehicle-assignments-driver-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vehicle_assignments' },
        () => {
          void fetchActiveAssignments(orgId)
        },
      )
      .subscribe()
    const timer = window.setInterval(() => {
      void fetchActiveAssignments(orgId)
    }, 30_000)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
    }
  }, [orgId, fetchActiveAssignments])

  // 指示 / 報告 / チャット の Realtime 購読
  const messages = useMobilityMessagesStore((s) => s.messages)
  const subscribeMessages = useMobilityMessagesStore((s) => s.subscribe)
  const unsubscribeMessages = useMobilityMessagesStore((s) => s.unsubscribe)
  useEffect(() => {
    if (!orgId) return
    subscribeMessages(orgId)
    return () => {
      unsubscribeMessages()
    }
  }, [orgId, subscribeMessages, unsubscribeMessages])

  const [showChatSheet, setShowChatSheet] = useState<
    | { kind: 'direct'; label: string }
    | { kind: 'project'; projectId: string; label: string }
    | null
  >(null)

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

  // 未読の 自分宛 direct + 参加現場 project にきた指示の件数
  const unreadInstructionCount = useMemo(() => {
    if (!user) return 0
    const projectIds = new Set(myProjects.map((p) => p.id))
    return messages.filter((m) => {
      if (m.message_kind !== 'instruction') return false
      if (m.read_at) return false
      if (m.sender_user_id === user.id) return false
      if (m.channel_kind === 'direct') return m.channel_user_id === user.id
      return m.channel_project_id != null && projectIds.has(m.channel_project_id)
    }).length
  }, [messages, myProjects, user])

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

  // 自分の運行履歴シート
  const [showLogsSheet, setShowLogsSheet] = useState(false)
  const [myLogSections, setMyLogSections] = useState<AssignmentWithNames[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  // 履歴で「タップで表示」した 1 セクション。地図にスピード色軌跡を描く。
  const [selectedLogSection, setSelectedLogSection] =
    useState<VehicleAssignment | null>(null)
  const [selectedLogPositions, setSelectedLogPositions] = useState<
    MobilityPosition[]
  >([])
  const [selectedLogLoading, setSelectedLogLoading] = useState(false)

  // シートを開いたら自分の履歴を fetch
  useEffect(() => {
    if (!showLogsSheet || !user) return
    let cancelled = false
    setLogsLoading(true)
    void (async () => {
      const rows = await fetchUserAssignmentHistory(user.id)
      if (!cancelled) {
        setMyLogSections(rows)
        setLogsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showLogsSheet, user, fetchUserAssignmentHistory])

  // 選択セクションの位置ログを fetch
  useEffect(() => {
    if (!selectedLogSection) {
      setSelectedLogPositions([])
      return
    }
    let cancelled = false
    setSelectedLogLoading(true)
    void (async () => {
      // 大きくても数千点なので一発で取る
      const rows = await fetchRecentPositions(selectedLogSection.id, 5000)
      if (!cancelled) {
        // fetchRecentPositions は DESC 返却 → 昇順に反転
        setSelectedLogPositions(rows.slice().reverse())
        setSelectedLogLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedLogSection, fetchRecentPositions])

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
  // 前回位置 (方位を「前点→現在」ベクトルで計算するため保持)。
  // GPS の heading は停車中や低速で不安定なので、実測ベクトルで置き換える。
  const prevPosForBearingRef = useRef<{ lat: number; lon: number } | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [lastAutoSentAt, setLastAutoSentAt] = useState<Date | null>(null)
  const [autoSend, setAutoSend] = useState(false)

  // 単位 (現在の乗車) 走行距離。myActive.started_at 以降を累積する。
  // 降車で新しい単位に切り替わり、次回乗車時は自動的に 0 から始まる。
  const [unitDistanceM, setUnitDistanceM] = useState(0)

  // 本日走行距離 (今日 00:00 以降の全乗車の合計)
  const [todayDistanceM, setTodayDistanceM] = useState(0)

  // 走行時間表示を「単位」/「本日」で切替 (パネルタップで反転)
  const [distanceMode, setDistanceMode] = useState<'unit' | 'today'>('unit')

  // 走行時間 (経過時間) の即時更新用に定期 tick する now
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!myActive) return
    const id = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [myActive])

  // ネットワーク接続状態 + オフラインキュー長 (UI 表示 + 送信ロジック用)
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [queueLen, setQueueLen] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  // マウント時にキュー長を再読み込み (アプリ再起動で残っているぶん)
  useEffect(() => {
    if (!user) return
    setQueueLen(getQueueLength(user.id))
  }, [user])

  // 地図追跡状態 (現在地に自動でセンタリング)。初期値 true。
  // ユーザーが地図をドラッグすると false になり、現在地ボタンで戻す。
  const [followMe, setFollowMe] = useState(true)
  // ヘディングアップ (地図を進行方向に回転)。初期値 false = 北向き。
  const [headingUp, setHeadingUp] = useState(false)
  // 直前に自分で setView した直後は dragstart ハンドラを 1 tick 抑制するフラグ
  const ignoreNextGestureRef = useRef(false)

  const autoSendRef = useRef(false)
  const myActiveRef = useRef<typeof myActive>(null)
  const lastSentAtRef = useRef<number>(0)
  useEffect(() => {
    autoSendRef.current = autoSend
    console.info('[MobilityDriverPage] autoSend →', autoSend)
  }, [autoSend])
  useEffect(() => {
    myActiveRef.current = myActive
    console.info('[MobilityDriverPage] myActive →', myActive?.id ?? null)
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

  // flushQueue で terminal-error (RLS violation 等) が起きたら
  // activeAssignments を強制 refresh するコールバック。
  // これで「古い closed assignment に向けて post → silent drop → UI 正常」の
  // ゴースト状態から抜け出せる。
  const orgIdRef = useRef<string | null>(null)
  useEffect(() => {
    orgIdRef.current = orgId
  }, [orgId])
  const onQueueTerminalRef = useRef((_assignmentId: string, _err: string) => {
    const oid = orgIdRef.current
    if (oid) void fetchActiveAssignments(oid)
  })

  // キュー介在の送信ヘルパー。
  //   1) 常に enqueue (localStorage に貯める)
  //   2) flushQueue で古い順から送信を試みる。1 件でも失敗したら残りは次回持越し
  //   3) UI 表示用に queueLen を最新化
  // これにより、電波が切れても最大 20 分ぶん貯めておいて後で一括送信できる。
  const userIdRef = useRef<string | null>(null)
  useEffect(() => {
    userIdRef.current = user?.id ?? null
  }, [user])
  const sendWithQueue = useCallback(
    async (
      assignmentId: string,
      sample: {
        lat: number
        lon: number
        accuracy_m: number | null
        speed_kmh: number | null
        heading_deg: number | null
        altitude_m: number | null
        recorded_at?: string
      },
    ) => {
      const uid = userIdRef.current
      if (!uid) return
      enqueuePing(uid, {
        assignmentId,
        lat: sample.lat,
        lon: sample.lon,
        accuracy_m: sample.accuracy_m ?? null,
        speed_kmh: sample.speed_kmh ?? null,
        heading_deg: sample.heading_deg ?? null,
        altitude_m: sample.altitude_m ?? null,
        recorded_at: sample.recorded_at ?? new Date().toISOString(),
      })
      const { remaining } = await flushQueue(uid, sendPositionRef.current, {
        onTerminal: onQueueTerminalRef.current,
      })
      setQueueLen(remaining)
    },
    [],
  )

  // オンライン復帰時に即キュー flush を試みる
  useEffect(() => {
    if (!isOnline || !user) return
    void (async () => {
      const { remaining } = await flushQueue(user.id, sendPositionRef.current, {
        onTerminal: onQueueTerminalRef.current,
      })
      setQueueLen(remaining)
    })()
  }, [isOnline, user])

  // 定期リトライ: 30 秒ごとにキューに何かあれば flush を試す
  // (online/offline イベントが取りこぼされたケースの保険)
  useEffect(() => {
    if (!user) return
    const id = setInterval(async () => {
      const before = getQueueLength(user.id)
      if (before === 0) return
      const { remaining } = await flushQueue(user.id, sendPositionRef.current, {
        onTerminal: onQueueTerminalRef.current,
      })
      setQueueLen(remaining)
    }, 30_000)
    return () => clearInterval(id)
  }, [user])

  // アプリが visible / focus に戻った瞬間は必ず flush を試みる。
  // Android のアプリ切替や、画面 OFF → 画面 ON でここに来る。
  useEffect(() => {
    if (!user) return
    const tryFlush = async () => {
      const before = getQueueLength(user.id)
      if (before === 0) return
      const { remaining } = await flushQueue(user.id, sendPositionRef.current, {
        onTerminal: onQueueTerminalRef.current,
      })
      setQueueLen(remaining)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tryFlush()
    }
    const onFocus = () => void tryFlush()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [user])

  // 「自動 ON」に切り替えた瞬間は 1 発すぐ送る (次の watchPosition を待たない)
  useEffect(() => {
    if (!autoSend || !myActive) return
    const pos = currentPos
    if (!pos) return
    lastSentAtRef.current = Date.now()
    setLastAutoSentAt(new Date())
    void sendWithQueue(myActive.id, {
      lat: pos[0],
      lon: pos[1],
      accuracy_m: accuracy,
      speed_kmh: null,
      heading_deg: null,
      altitude_m: null,
    })
    // 依存に currentPos は入れない (何度も送らないため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, myActive, sendWithQueue])

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
            const uid = userIdRef.current
            // throttle 対象外: この callback が発火した=画面 OFF でも生きているタイミング。
            // 通信不通後の復帰チャンスなので、キューに残ってる古い ping を先に流す。
            if (uid) {
              void flushQueue(uid, sendPositionRef.current, {
                onTerminal: onQueueTerminalRef.current,
              }).then((r) =>
                setQueueLen(r.remaining),
              )
            }
            const now = Date.now()
            if (now - lastSentAtRef.current < PING_INTERVAL_MS) return
            lastSentAtRef.current = now
            setLastAutoSentAt(new Date(now))
            void sendWithQueue(active.id, {
              lat: sample.lat,
              lon: sample.lon,
              accuracy_m: sample.accuracy_m,
              speed_kmh: sample.speed_kmh,
              heading_deg: sample.heading_deg,
              altitude_m: sample.altitude_m,
            })
          },
          {
            notificationTitle: 'NodeCloudモビリティ',
            notificationBody: `${myVehicle?.name ?? '車両'} の現在地を送信中`,
            // 停車中でも callback が起きやすいよう小さめに (バッテリー影響は僅か)
            distanceFilter: 1,
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
            // 方位は「前回位置 → 今回位置」のベクトルで計算する。
            // GPS 自体の heading は停止中や低速で null / 揺らぎが大きく実感と合わないため。
            // 動きが 3m 未満なら振れやすいので更新しない (前の方位を維持)。
            {
              const prev = prevPosForBearingRef.current
              const cur = { lat: sample.lat, lon: sample.lon }
              if (prev) {
                const seg = haversineMeters(prev, cur)
                if (seg >= 3) {
                  setCurrentHeadingDeg(bearingDeg(prev, cur))
                  prevPosForBearingRef.current = cur
                }
                // 3m 未満は prev を更新しない → 少しずつ動いた累積で判定できる
              } else {
                prevPosForBearingRef.current = cur
              }
            }
            setLocationError(null)

            // 乗車中 + 自動送信 ON なら throttle して送る
            const active = myActiveRef.current
            if (!autoSendRef.current || !active) return
            const uid = userIdRef.current
            // throttle 対象外: この callback ごとに古い queue を flush 試行
            if (uid) {
              void flushQueue(uid, sendPositionRef.current, {
                onTerminal: onQueueTerminalRef.current,
              }).then((r) =>
                setQueueLen(r.remaining),
              )
            }
            const now = Date.now()
            if (now - lastSentAtRef.current < PING_INTERVAL_MS) return
            lastSentAtRef.current = now
            setLastAutoSentAt(new Date(now))
            void sendWithQueue(active.id, {
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

  // セクション距離: 現在の乗車 (myActive.started_at) 以降の自分の位置から累積。
  // - 送信 (lastAutoSentAt) or 乗車状態 (myActive) の変化で再計算
  // - myActive がある間は 20 秒ごとに軽く refresh
  // 降車すると myActive=null → 0 にリセット、次回乗車で新しい単位から再カウント。
  useEffect(() => {
    if (!user || !myActive) {
      setUnitDistanceM(0)
      return
    }
    let cancelled = false
    const compute = async () => {
      const rows = await fetchPositionsForUserSince(user.id, myActive.started_at)
      if (cancelled) return
      const m = computeTotalDistanceMeters(rows)
      setUnitDistanceM(m)
    }
    void compute()
    const timer = setInterval(compute, 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [user, myActive, lastAutoSentAt, fetchPositionsForUserSince])

  // 本日走行距離: 今日 00:00 以降の自分の位置ログ全体から累積 (全 assignment 横断)
  useEffect(() => {
    if (!user) {
      setTodayDistanceM(0)
      return
    }
    let cancelled = false
    const compute = async () => {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const rows = await fetchPositionsForUserSince(
        user.id,
        startOfToday.toISOString(),
      )
      if (cancelled) return
      setTodayDistanceM(computeTotalDistanceMeters(rows))
    }
    void compute()
    const timer = myActive ? setInterval(compute, 30_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [user, myActive, lastAutoSentAt, fetchPositionsForUserSince])

  // セクション走行時間 (myActive.started_at から現在まで)。
  // 本日走行の合計時間は現行 UI では表示していないため計算しない。
  const unitDurationMs = myActive
    ? Math.max(0, nowTick - new Date(myActive.started_at).getTime())
    : 0

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
  const isMobilityAppFlag = useMemo(() => isMobilityApp(), [])
  // mobility 専用アプリ (Capacitor) では常にネイティブ環境なので PC 警告は不要
  const [showPcWarning, setShowPcWarning] = useState(
    () => !isMobileDevice() && !isMobilityApp(),
  )

  const handleBoard = async (vehicleId: string) => {
    setBusyError(null)
    setBusy(true)
    try {
      const res = await startAssignment(vehicleId)
      if (!res) throw new Error(useMobilityStore.getState().vehiclesError ?? '開始に失敗')
      setShowPicker(false)
      setAutoSend(true) // 乗車と同時に自動送信 ON
    } catch (err) {
      setBusyError(friendlyMobilityError(err))
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
      setBusyError(friendlyMobilityError(err))
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
        {/* mobility 専用アプリでは他画面が無いので戻るボタンを隠す */}
        {!isMobilityAppFlag && (
          <button
            onClick={() => navigate('/')}
            className="p-1 rounded hover:bg-slate-700 shrink-0"
            title="トップに戻る"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="text-base font-bold flex-1">
          {isMobilityAppFlag ? 'NodeCloudモビリティ' : 'NodeCloud'}
        </div>
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

      {/* 速度・セクション距離・行き先パネル (乗車中のみ、常に 3 列) */}
      {myActive && (
        <div className="mx-3 mt-2 grid gap-2 shrink-0 grid-cols-3">
          {/* 速度 */}
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-white">
            <div className="text-[10px] text-slate-400">現在速度</div>
            <div className="text-2xl font-bold leading-tight">
              {currentSpeedKmh != null && currentSpeedKmh >= 0
                ? Math.round(currentSpeedKmh)
                : '—'}
              <span className="text-xs font-normal text-slate-300 ml-1">km/h</span>
            </div>
          </div>
          {/* セクション / 本日走行 (切替) */}
          <button
            type="button"
            onClick={() =>
              setDistanceMode((m) => (m === 'unit' ? 'today' : 'unit'))
            }
            style={{ touchAction: 'manipulation' }}
            className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-white text-left active:bg-slate-700"
            title="タップで セクション走行 / 本日走行 を切替"
          >
            <div className="text-[10px] text-slate-400 flex items-center gap-1">
              <span className="flex-1">
                {distanceMode === 'unit' ? 'セクション' : '本日走行'}
              </span>
              <span className="text-[9px] text-slate-500">↔</span>
            </div>
            <div className="text-2xl font-bold leading-tight">
              {(
                (distanceMode === 'unit' ? unitDistanceM : todayDistanceM) / 1000
              ).toFixed(1)}
              <span className="text-xs font-normal text-slate-300 ml-1">km</span>
            </div>
            {distanceMode === 'unit' && (
              <div className="text-[9px] text-slate-400 mt-0.5">
                {new Date(myActive.started_at).toLocaleTimeString('ja-JP', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                〜 {formatDurationShort(unitDurationMs)}
              </div>
            )}
          </button>
          {/* 行き先 (常に表示。未設定タップでピッカー、設定済みは方向+距離) */}
          {selectedDestination && destInfo ? (
            <div className="bg-slate-800 border border-amber-600/70 rounded-lg p-2 text-white relative min-w-0">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowDestSheet(true)}
                  className="flex-1 min-w-0 text-left"
                  title="タップで行き先を変更"
                >
                  <span className="text-[10px] text-amber-200 truncate block">
                    → {selectedDestination.name}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void applyDestination(null)}
                  disabled={destBusy}
                  className="shrink-0 h-4 w-4 rounded hover:bg-slate-700 flex items-center justify-center disabled:opacity-50 text-slate-400"
                  title="行き先を解除"
                >
                  {destBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowDestSheet(true)}
                className="w-full text-left"
              >
                <div className="flex items-center gap-1 mt-0.5">
                  <Navigation
                    className="h-5 w-5 text-amber-300 shrink-0"
                    style={{
                      transform: `rotate(${
                        headingUp
                          ? destInfo.deg - (currentHeadingDeg ?? 0)
                          : destInfo.deg
                      }deg)`,
                      transition: 'transform 250ms',
                    }}
                  />
                  <div className="text-lg font-bold leading-tight">
                    {formatDistance(destInfo.meters)}
                  </div>
                </div>
                <div className="text-[9px] text-amber-200/80 mt-0.5">
                  {destInfo.label} {Math.round(destInfo.deg)}°
                </div>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDestSheet(true)}
              className="bg-slate-800 border border-dashed border-slate-600 rounded-lg p-2 text-left text-slate-400 hover:border-amber-500 hover:text-amber-300 active:bg-slate-700 flex flex-col justify-between min-w-0"
              title="タップで行き先を選ぶ"
            >
              <div className="text-[10px] flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span>行き先</span>
              </div>
              <div className="text-sm font-medium leading-tight mt-1">未設定</div>
              <div className="text-[9px] text-slate-500 mt-0.5">タップで選択</div>
            </button>
          )}
        </div>
      )}

      {/* 地図 */}
      <div className="flex-1 relative">
        <MapContainer
          center={[35.681236, 139.767125]}
          zoom={15}
          zoomControl={false}
          className="h-full w-full"
          {...({ rotate: true, bearing: 0, rotateControl: false } as Record<string, unknown>)}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FollowMe
            pos={currentPos}
            followMe={followMe}
            onProgrammaticMove={() => {
              ignoreNextGestureRef.current = true
              // 次の tick までは dragstart を追跡 OFF に使わない
              setTimeout(() => {
                ignoreNextGestureRef.current = false
              }, 500)
            }}
          />
          <MapUserGestureWatcher
            onUserPan={() => {
              if (ignoreNextGestureRef.current) return
              setFollowMe(false)
            }}
          />
          <MapBearingUpdater enabled={headingUp} heading={currentHeadingDeg} />
          {trackLine.length > 1 && (
            <Polyline positions={trackLine} pathOptions={{ color: '#6366f1', weight: 4 }} />
          )}
          {/* 履歴シートで選んだセクションを スピード色 で重ね描画 */}
          {selectedLogPositions.length > 1 &&
            speedSegments(selectedLogPositions).map((seg, idx) => (
              <Polyline
                key={`log-seg-${selectedLogSection?.id ?? 'x'}-${idx}`}
                positions={seg.positions}
                pathOptions={{ color: seg.color, weight: 4, opacity: 0.95 }}
              />
            ))}
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
              // 車両マーカーより手前に描く (近接時に埋もれないように)
              zIndexOffset={1000}
            />
          )}
          {currentPos && (
            <VehicleMarker
              position={currentPos}
              // ヘディングアップ中は地図側が回転するので、マーカーは常に
              // 画面上向き = 進行方向を向くよう cone を 0° 固定にする。
              // (leaflet-rotate は divIcon を counter-rotate して画面基準で
              //  上を保つため、cone の SVG 内回転を 0 にすれば実世界の進行方向と一致)
              heading={headingUp ? 0 : currentHeadingDeg}
              color={myActive ? '#10b981' : '#3b82f6'}
              size={22}
            />
          )}
          <MapControlStack
            followMe={followMe}
            headingUp={headingUp}
            onToggleFollow={() => {
              // OFF → ON にする時は即センタリング
              setFollowMe((prev) => !prev)
            }}
            onToggleHeading={() => setHeadingUp((prev) => !prev)}
          />
        </MapContainer>
      </div>

      {busyError && (
        <div className="mx-3 my-2 p-2 bg-red-900/60 border border-red-700 rounded text-xs text-red-100 flex items-start gap-2">
          <span className="flex-1 whitespace-pre-wrap break-words">{busyError}</span>
          <button
            type="button"
            onClick={() => setBusyError(null)}
            className="shrink-0 p-1 rounded hover:bg-red-800/60"
            title="エラーを閉じる"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 選択中のログセクションを解除するミニバー (選ばれている間だけ表示) */}
      {selectedLogSection && (
        <div className="mx-3 mb-1 mt-2 px-2 py-1 text-[10px] rounded bg-indigo-900/40 border border-indigo-700 text-indigo-100 flex items-center gap-2">
          <History className="h-3 w-3 shrink-0" />
          <span className="flex-1 truncate">
            履歴表示中:{' '}
            {new Date(selectedLogSection.started_at).toLocaleString('ja-JP', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {selectedLogSection.ended_at && (
              <>
                {' '}
                〜{' '}
                {new Date(selectedLogSection.ended_at).toLocaleTimeString('ja-JP', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </>
            )}
            {selectedLogLoading && <Loader2 className="h-3 w-3 animate-spin inline ml-1" />}
          </span>
          <button
            type="button"
            onClick={() => setSelectedLogSection(null)}
            className="shrink-0 h-6 px-2 rounded text-[10px] border border-indigo-500 hover:bg-indigo-800"
          >
            解除
          </button>
        </div>
      )}

      {/* フッタアクション */}
      <div className="p-3 bg-slate-800 flex flex-col gap-2 shrink-0">
        <div className="flex gap-2">
          {/* 履歴シートを開くボタン (乗車/未乗車どちらでも常に見える) */}
          <button
            type="button"
            onClick={() => setShowLogsSheet(true)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-indigo-500 text-indigo-200 hover:bg-indigo-950/40"
          >
            <History className="h-4 w-4" />
            運行履歴
          </button>
          {/* メッセージ / 指示 バッジ付き */}
          <button
            type="button"
            onClick={() => setShowChatSheet({ kind: 'direct', label: '管理者' })}
            className="relative flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-emerald-500 text-emerald-200 hover:bg-emerald-950/40"
          >
            <MessageSquare className="h-4 w-4" />
            メッセージ
            {unreadInstructionCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {unreadInstructionCount}
              </span>
            )}
          </button>
        </div>
        {myActive ? (
          <div className="flex gap-2">
            {/* 自動送信トグル: メインの大ボタン (下に小さくステータス) */}
            <button
              onClick={() => setAutoSend((v) => !v)}
              disabled={busy}
              role="switch"
              aria-checked={autoSend}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-3 py-2 text-base font-semibold rounded-lg transition ${
                autoSend
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
              }`}
              title={autoSend ? 'タップで自動送信を停止' : 'タップで自動送信を開始'}
            >
              <span className="flex items-center gap-2">
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
              </span>
              {/* ステータスをボタン内に小さく表示 (ON 時のみ) */}
              {autoSend && (
                <span
                  className={`text-[10px] leading-tight font-normal flex items-center gap-1 ${
                    !isOnline
                      ? 'text-red-200'
                      : queueLen > 0
                        ? 'text-amber-200'
                        : 'text-emerald-100/90'
                  }`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      !isOnline
                        ? 'bg-red-300'
                        : queueLen > 0
                          ? 'bg-amber-300 animate-pulse'
                          : 'bg-white animate-pulse'
                    }`}
                  />
                  {!isOnline
                    ? `通信断 · バッファ ${queueLen} 件`
                    : queueLen > 0
                      ? `再送中 · 残 ${queueLen} 件`
                      : `自動送信中${
                          lastAutoSentAt
                            ? ' · 最終 ' +
                              lastAutoSentAt.toLocaleTimeString('ja-JP', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })
                            : ''
                        }`}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleLeave}
              disabled={busy}
              style={{ touchAction: 'manipulation' }}
              className="shrink-0 flex items-center gap-1 px-4 py-3 text-sm font-semibold border border-red-500 bg-red-950/40 text-red-200 rounded-lg active:bg-red-900/60 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              降車
            </button>
          </div>
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

      {showLogsSheet && (
        <MyLogsSheet
          sections={myLogSections}
          loading={logsLoading}
          selectedId={selectedLogSection?.id ?? null}
          vehicles={vehicles}
          onSelect={(a) => {
            setSelectedLogSection(a)
            setShowLogsSheet(false)
          }}
          onClose={() => setShowLogsSheet(false)}
        />
      )}

      {showChatSheet && orgId && user && (
        <ChatSheet
          organizationId={orgId}
          myUserId={user.id}
          myProjects={myProjects}
          selected={showChatSheet}
          onSelectTab={(next) => setShowChatSheet(next)}
          activeAssignmentId={myActive?.id ?? null}
          currentLat={currentPos?.[0] ?? null}
          currentLon={currentPos?.[1] ?? null}
          onConfirmed={async () => {
            // 確認で assignment が RPC 側で作られたので active を再取得
            if (orgId) await fetchActiveAssignments(orgId)
          }}
          onArrived={async () => {
            if (orgId) await fetchActiveAssignments(orgId)
          }}
          onClose={() => setShowChatSheet(null)}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// メッセージシート (ドライバー): 直接メッセージ / 現場チャンネルをタブで切替
// -----------------------------------------------------------------------------
function ChatSheet({
  organizationId,
  myUserId,
  myProjects,
  selected,
  onSelectTab,
  activeAssignmentId,
  currentLat,
  currentLon,
  onConfirmed,
  onArrived,
  onClose,
}: {
  organizationId: string
  myUserId: string
  myProjects: MobilityProject[]
  selected:
    | { kind: 'direct'; label: string }
    | { kind: 'project'; projectId: string; label: string }
  onSelectTab: (
    next:
      | { kind: 'direct'; label: string }
      | { kind: 'project'; projectId: string; label: string },
  ) => void
  activeAssignmentId: string | null
  currentLat: number | null
  currentLon: number | null
  onConfirmed: () => Promise<void>
  onArrived: () => Promise<void>
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[3500] bg-black/60 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md h-[80vh] rounded-t-2xl sm:rounded-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <MessageSquare className="h-5 w-5 text-emerald-600" />
          <h3 className="text-base font-semibold flex-1">メッセージ</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* タブ: 管理者 direct + 参加中プロジェクト */}
        <div className="flex overflow-x-auto border-b bg-slate-50 shrink-0">
          <button
            type="button"
            onClick={() => onSelectTab({ kind: 'direct', label: '管理者' })}
            className={`px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap ${
              selected.kind === 'direct'
                ? 'border-emerald-500 text-emerald-700 bg-white'
                : 'border-transparent text-slate-500'
            }`}
          >
            管理者
          </button>
          {myProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                onSelectTab({ kind: 'project', projectId: p.id, label: p.name })
              }
              className={`px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap ${
                selected.kind === 'project' && selected.projectId === p.id
                  ? 'border-emerald-500 text-emerald-700 bg-white'
                  : 'border-transparent text-slate-500'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 p-2">
          <MobilityChatPanel
            organizationId={organizationId}
            channelKind={selected.kind}
            channelUserId={selected.kind === 'direct' ? myUserId : null}
            channelProjectId={
              selected.kind === 'project' ? selected.projectId : null
            }
            senderRole="driver"
            showDriverConfirm
            activeAssignmentId={activeAssignmentId}
            currentLat={currentLat}
            currentLon={currentLon}
            onConfirmed={() => void onConfirmed()}
            onArrived={() => void onArrived()}
          />
        </div>
      </div>
    </div>
  )
}

// 目的地 (ピン) の Leaflet アイコン。名称吹き出し + 下向き三角形。
// 描画は: 幅 W x 高さ H の bounding box を用意し、iconAnchor をボックス下端中央 (W/2, H)
// に置く。ボックスの下端に三角形の tip が来るよう配置する。
// これで pin の tip がちょうど destination の緯度経度に刺さる。
const DEST_ICON_W = 200
const DEST_ICON_TAIL_H = 8
const DEST_ICON_BODY_H = 22
const DEST_ICON_H = DEST_ICON_BODY_H + DEST_ICON_TAIL_H

function buildDestinationIcon(name: string): L.DivIcon {
  const safe = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // display:inline-block の bubble + 三角形。overflow:visible にして
  // 親コンテナの clipping を防ぐ。
  const html = `
    <div style="width:${DEST_ICON_W}px;height:${DEST_ICON_H}px;overflow:visible;pointer-events:none;text-align:center;">
      <div style="display:inline-block;background:#f59e0b;color:#111827;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.5);max-width:${DEST_ICON_W - 8}px;overflow:hidden;text-overflow:ellipsis;line-height:${DEST_ICON_BODY_H - 6}px;">🚩 ${safe}</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:${DEST_ICON_TAIL_H}px solid #f59e0b;margin:0 auto;"></div>
    </div>`
  return L.divIcon({
    className: 'mobility-destination-icon',
    html,
    iconSize: [DEST_ICON_W, DEST_ICON_H],
    // 下端中央に geo 位置が来るように iconAnchor を [W/2, H] に置く
    iconAnchor: [DEST_ICON_W / 2, DEST_ICON_H],
  })
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`
}

/**
 * サーバーエラーをユーザー向けにわかりやすく訳す。
 * PostgreSQL の unique constraint violation (23505) など、
 * 生の英文だと何のことかわからないケースを日本語に置き換える。
 */
function friendlyMobilityError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('uidx_vehicle_assignments_one_active_per_vehicle')) {
    return 'この車両はすでに別の割当が稼働中です。降車操作が反映される数秒お待ちください。'
  }
  if (raw.includes('23505')) {
    return `重複するデータがあり登録できませんでした。\n${raw}`
  }
  return raw
}

/** 走行時間を "Xh Ym" / "Ym" にまとめる (0m 以下は "0m") */
function formatDurationShort(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMins = Math.floor(ms / 60_000)
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
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
                    zIndexOffset={1000}
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
                          {busyBy.driver_name || '他ドライバー'} 乗車中
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

// -----------------------------------------------------------------------------
// 自分の運行履歴シート (ドライバー本人向け)
// - fetchUserAssignmentHistory で自分の割当を DESC で受け取ってそのまま列挙
// - 「今日 / 昨日 / それ以前」でグループ表示
// - タップで親に選択セクションを渡し、地図にスピード色軌跡を出す
// -----------------------------------------------------------------------------
function MyLogsSheet({
  sections,
  loading,
  selectedId,
  vehicles,
  onSelect,
  onClose,
}: {
  sections: AssignmentWithNames[]
  loading: boolean
  selectedId: string | null
  vehicles: Vehicle[]
  onSelect: (a: AssignmentWithNames) => void
  onClose: () => void
}) {
  const vehicleById = useMemo(() => {
    const m = new Map<string, Vehicle>()
    for (const v of vehicles) m.set(v.id, v)
    return m
  }, [vehicles])

  // グルーピング用の「日付ラベル」を返す (JST)
  const groupKey = (iso: string): string => {
    const d = new Date(iso)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const start = new Date(d)
    start.setHours(0, 0, 0, 0)
    if (start.getTime() === today.getTime()) return '今日'
    if (start.getTime() === yesterday.getTime()) return '昨日'
    return `${start.getMonth() + 1}/${start.getDate()}`
  }

  const grouped = useMemo(() => {
    const map = new Map<string, AssignmentWithNames[]>()
    for (const s of sections) {
      const k = groupKey(s.started_at)
      const arr = map.get(k)
      if (arr) arr.push(s)
      else map.set(k, [s])
    }
    return Array.from(map.entries())
  }, [sections])

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
          <History className="h-4 w-4 text-indigo-600" />
          <h3 className="text-base font-semibold flex-1">
            自分の運行履歴 ({sections.length})
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="p-6 flex justify-center text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : sections.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              運行履歴がありません
            </div>
          ) : (
            grouped.map(([label, rows]) => (
              <div key={label}>
                <div className="sticky top-0 px-3 py-1.5 bg-slate-100 text-[11px] text-slate-600 font-semibold">
                  {label}
                </div>
                <ul className="divide-y">
                  {rows.map((a) => {
                    const v = vehicleById.get(a.vehicle_id)
                    const durationMs = a.ended_at
                      ? new Date(a.ended_at).getTime() -
                        new Date(a.started_at).getTime()
                      : Date.now() - new Date(a.started_at).getTime()
                    const h = Math.floor(durationMs / 3_600_000)
                    const m = Math.floor((durationMs % 3_600_000) / 60_000)
                    const isSelected = selectedId === a.id
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(a)}
                          className={`w-full flex items-center gap-3 p-3 text-left active:bg-indigo-50 ${
                            isSelected ? 'bg-indigo-50' : ''
                          }`}
                        >
                          <div
                            className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                              isSelected ? 'bg-indigo-200' : 'bg-slate-100'
                            }`}
                          >
                            <Car
                              className={`h-4 w-4 ${
                                isSelected ? 'text-indigo-700' : 'text-slate-500'
                              }`}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold truncate">
                              {v?.name ?? '(不明車両)'}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {new Date(a.started_at).toLocaleTimeString('ja-JP', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {a.ended_at ? (
                                <>
                                  {' 〜 '}
                                  {new Date(a.ended_at).toLocaleTimeString(
                                    'ja-JP',
                                    {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    },
                                  )}
                                </>
                              ) : (
                                <span className="ml-1 text-emerald-600">
                                  (乗車中)
                                </span>
                              )}
                              <span className="ml-2 text-slate-400">
                                · {h > 0 ? `${h}h ` : ''}{m}m
                              </span>
                            </div>
                            {a.destination_point && (
                              <div className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5 truncate">
                                <MapPin className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {a.destination_point.name}
                                </span>
                              </div>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        {/* スピード凡例 */}
        <div className="p-3 border-t bg-slate-50">
          <div className="text-[10px] text-slate-600 font-semibold mb-1">
            軌跡は速度で色分け (km/h)
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {SPEED_BANDS.map((b) => (
              <div key={b.min} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-4 rounded"
                  style={{ backgroundColor: b.color }}
                />
                <span className="text-[10px] text-slate-600">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
