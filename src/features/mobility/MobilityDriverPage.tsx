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
  Send,
  CircleDot,
  Minus,
  Navigation,
  Play,
  Plus,
  Truck,
  X,
} from 'lucide-react'
import L from 'leaflet'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
} from 'react-leaflet'
import { VehicleMarker } from '@/features/mobility/VehicleMarker'
import { SPEED_BANDS, speedSegments } from '@/features/mobility/speedBands'
import 'leaflet/dist/leaflet.css'
import { CachedTileLayer } from '@/components/map/CachedTileLayer'
import { SaveViewButton } from '@/components/map/SaveViewButton'
import { tileClear, tileUsage } from '@/lib/offlineDb'
import {
  BASE_LAYERS,
  loadBaseLayer,
  saveBaseLayer,
  type BaseLayerKey,
} from '@/lib/baseLayers'
// leaflet-rotate は L.Map に rotate/setBearing を注入する副作用 import。
// ヘディングアップ用に必要 (MobileStakingPage が既に import 済みだが、直接
// このページを開いても動くよう明示的に import しておく)。
import 'leaflet-rotate'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { isMobileDevice } from '@/lib/displayMode'
import { watchSamples, watchSamplesInBackground } from '@/lib/geolocation'
import { endLiveActivity, setAppBadge, updateLiveActivity } from '@/lib/appBadge'
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

// 送信間隔 (ms)。移動中は 10 秒、停止中は 60 秒。
//
// 停止中も 10 秒で 打ち続けると、圏外が 長い 現場 (山岳 / 海上) では 同じ座標が
// 数千件 溜まって キューを 圧迫し、徒歩利用では バッテリーも 食う。
// 停止判定は 速度と 前回送信地点からの 距離の 両方で 行う (速度が null の
// 端末があるため)。
const PING_INTERVAL_MS = 10_000
const PING_INTERVAL_IDLE_MS = 60_000
/** これ未満なら「停止中」とみなす速度 [km/h] */
const IDLE_SPEED_KMH = 1.5
/** これ未満なら「停止中」とみなす前回送信地点からの距離 [m] */
const IDLE_MOVE_M = 15

/** 目的地からこの距離以内なら到着とみなす [m] */
const ARRIVAL_RADIUS_M = 100

/** 直近に乗車した車両 (次回の車両選択で先頭に出す) */
const LAST_VEHICLE_KEY = 'mobility:lastVehicleId'

/** 直前の送信からの経過が 送信間隔を満たしているか (停止中は間隔を伸ばす) */
function shouldSendNow(
  now: number,
  lastSentAt: number,
  lastSentPos: { lat: number; lon: number } | null,
  sample: { lat: number; lon: number; speed_kmh: number | null },
  distanceMeters: (
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
  ) => number,
): boolean {
  const elapsed = now - lastSentAt
  if (elapsed >= PING_INTERVAL_IDLE_MS) return true
  if (elapsed < PING_INTERVAL_MS) return false
  // 10〜60 秒の間は「動いていれば送る / 止まっていれば待つ」
  const speed = sample.speed_kmh
  if (speed != null && speed >= IDLE_SPEED_KMH) return true
  if (!lastSentPos) return true
  return distanceMeters(lastSentPos, { lat: sample.lat, lon: sample.lon }) >= IDLE_MOVE_M
}

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

// 長押し (mobile では touch 押し続け、PC では右クリック) で発火。
// Leaflet の contextmenu イベントは両方の入力を統合して発火する。
function MapLongPressHandler({
  onLongPress,
}: {
  onLongPress: (lat: number, lon: number) => void
}) {
  const map = useMap()
  useEffect(() => {
    const handler = (e: L.LeafletMouseEvent) => {
      onLongPress(e.latlng.lat, e.latlng.lng)
    }
    map.on('contextmenu', handler)
    return () => {
      map.off('contextmenu', handler)
    }
  }, [map, onLongPress])
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
  showTrackPoints,
  onToggleFollow,
  onToggleHeading,
  onToggleTrackPoints,
}: {
  followMe: boolean
  headingUp: boolean
  showTrackPoints: boolean
  onToggleFollow: () => void
  onToggleHeading: () => void
  onToggleTrackPoints: () => void
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
  const btnPointsActive = 'bg-purple-500 text-white border-purple-600'
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
        className={`${btnBase} -mt-px ${btnInactive}`}
        title="縮小"
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleTrackPoints()
        }}
        className={`${btnBase} -mt-px rounded-b ${
          showTrackPoints ? btnPointsActive : btnInactive
        }`}
        title={showTrackPoints ? '軌跡の点を非表示' : '軌跡の点を表示'}
      >
        <CircleDot className="h-4 w-4" />
      </button>
    </div>
  )
}

export function MobilityDriverPage() {
  const navigate = useNavigate()
  const canUse = useCanUseMobility()
  const { user, profile, displayName, signOut } = useAuth()
  const orgId = profile?.organization_id ?? null

  const {
    vehicles,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    startAssignment,
    endAssignment,
    setAssignmentDestination,
    sendPositions,
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

  // メッセージは admin↔driver の direct のみ (現場チャンネルは廃止)
  const [showChatSheet, setShowChatSheet] = useState<
    { kind: 'direct'; label: string } | null
  >(null)

  // 割り当てられたカテゴリ (プロジェクト) の一覧
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

  // 組織内の全プロジェクト (ポイント登録の宛先選択用)。
  // 未分類も含む。myProjects (自分がメンバーの現場) とは別物。
  const [orgProjects, setOrgProjects] = useState<MobilityProject[]>([])
  const reloadOrgProjects = useCallback(async () => {
    if (!orgId) return
    try {
      const { data } = await supabase
        .from('mobility_projects')
        .select('*')
        .eq('organization_id', orgId)
        .eq('active', true)
        .order('name')
      setOrgProjects((data ?? []) as MobilityProject[])
    } catch {
      /* noop */
    }
  }, [orgId])
  useEffect(() => {
    void reloadOrgProjects()
  }, [reloadOrgProjects])

  // 地図長押しで開くポイント登録ダイアログ
  const [pointRegisterDialog, setPointRegisterDialog] = useState<{
    lat: number
    lon: number
  } | null>(null)

  // 未読の 自分宛 direct 指示の件数 (メッセージは admin↔driver の direct のみ)
  const unreadInstructionCount = useMemo(() => {
    if (!user) return 0
    return messages.filter((m) => {
      if (m.message_kind !== 'instruction') return false
      if (m.read_at) return false
      if (m.sender_user_id === user.id) return false
      return m.channel_kind === 'direct' && m.channel_user_id === user.id
    }).length
  }, [messages, user])

  // ボタンに出す「最新の受信メッセージ」。自分が送ったものは除く。
  // 指示だけでなく連絡 (note) も対象にする。
  const latestIncoming = useMemo(() => {
    if (!user) return null
    // 送信者では絞らない。管理者とドライバーが同一アカウント (小規模事業者や
    // 動作確認では普通にある) だと、自分基準の除外では全部落ちてしまう。
    // 確認 / 到着報告は本文が無く読む価値も無いので、それだけ除く。
    const incoming = messages
      .filter((m) => m.message_kind === 'instruction' || m.message_kind === 'note')
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    return incoming[0] ?? null
  }, [messages])

  // 最新メッセージの送信者名。ボタンに「誰から」を出すために引く。
  // profiles を 1 件だけ引くので負荷は無視できる
  const [latestSenderName, setLatestSenderName] = useState<string | null>(null)
  useEffect(() => {
    const id = latestIncoming?.sender_user_id
    if (!id) {
      setLatestSenderName(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('user_id', id)
          .maybeSingle()
        if (!cancelled) {
          setLatestSenderName((data as { full_name: string | null } | null)?.full_name ?? null)
        }
      } catch {
        /* 名前が引けなくても本文は出す */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [latestIncoming?.sender_user_id])

  // 報告の下書き。ドライバーが送信ボタンを押すまで送らない。
  // 走行中に文章を打たせないための仕組みで、勝手には送らない。
  const [notePrompt, setNotePrompt] = useState<string | null>(null)
  const [noteSending, setNoteSending] = useState(false)
  const sendNote = useMobilityMessagesStore((st) => st.sendNote)
  /** 出発報告を出した行き先 (同じ行き先で何度も促さない) */
  const departNotifiedRef = useRef<string | null>(null)
  /** 到着報告を出した行き先 */
  const arriveNotifiedRef = useRef<string | null>(null)

  /** 未読の受信メッセージ数 (指示に限らない) */
  const unreadIncomingCount = useMemo(() => {
    if (!user) return 0
    return messages.filter(
      (m) =>
        !m.read_at &&
        (m.message_kind === 'instruction' || m.message_kind === 'note') &&
        m.sender_user_id !== user.id,
    ).length
  }, [messages, user])
  const hasUnreadIncoming = unreadIncomingCount > 0

  // 未読数を iOS のアプリアイコンのバッジに出す。
  // アプリが動いている間だけ更新できる (プッシュ通知は未導入)。
  useEffect(() => {
    void setAppBadge(unreadIncomingCount)
  }, [unreadIncomingCount])

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
  /** 指示で指定された行き先。確定画面から開くために持つ */
  const [destInitialPoint, setDestInitialPoint] = useState<MobilityProjectPoint | null>(
    null,
  )
  const [destBusy, setDestBusy] = useState(false)
  const [destError, setDestError] = useState<string | null>(null)

  // 地図に出す全ポイント (カテゴリ横断)。目的地の候補になるので、
  // 見えているカテゴリの分をまとめて持つ。
  const [allPoints, setAllPoints] = useState<MobilityProjectPoint[]>([])
  const reloadAllPoints = useCallback(async () => {
    if (orgProjects.length === 0) {
      setAllPoints([])
      return
    }
    const lists = await Promise.all(orgProjects.map((pr) => fetchProjectPoints(pr.id)))
    setAllPoints(lists.flat().filter((p) => p.active))
  }, [orgProjects, fetchProjectPoints])
  useEffect(() => {
    void reloadAllPoints()
  }, [reloadAllPoints])

  // 背景地図。既定は航空写真 (現場の地形が分かる方が運行では役に立つ)
  const [baseLayer, setBaseLayer] = useState<BaseLayerKey>(() =>
    loadBaseLayer('mobility:baseLayer', 'photo'),
  )
  // 保存済み地図の容量。走行中に増えるので時々見直す
  const [tileMB, setTileMB] = useState<number | null>(null)
  useEffect(() => {
    const read = () => {
      void tileUsage().then((u) => setTileMB(u.bytes / 1024 / 1024))
    }
    read()
    const id = setInterval(read, 60_000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    saveBaseLayer('mobility:baseLayer', baseLayer)
  }, [baseLayer])

  /** 指示の行き先 id から地点を引く。地図表示用に全件持っているので流用する */
  const pointById = useCallback(
    (id: string | null | undefined) =>
      id ? allPoints.find((p) => p.id === id) ?? null : null,
    [allPoints],
  )

  /** 地図上のポイントをタップしたときの確認シート */
  const [pointActionTarget, setPointActionTarget] = useState<MobilityProjectPoint | null>(null)

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
  // 乗車と自動送信は 区別しない。乗車していれば 常に 送る。
  // 以前は useState(false) だったため、アプリを 再起動すると サーバー上は
  // 乗車中でも 送信が OFF のままで、位置が 送られなかった。
  // myActive は サーバーの activeAssignments から 導出されるので、
  // 起動時に 乗車中の 車両が あれば そのまま 送信が 再開する。
  const autoSend = !!myActive

  // 走行距離はクライアント側で完全に累積 + localStorage 永続化。
  // ・オフラインでも即時反映
  // ・アプリを閉じても永続化 (次回起動時に復元)
  // ・サーバ fetch は「localStorage が空 (初回 or 別端末)」のときだけフォールバック
  const [unitDistanceM, setUnitDistanceM] = useState(0)

  const [todayDistanceM, setTodayDistanceM] = useState(0)
  // ping 間セグメント計算用の前回位置。距離集計専用 (bearing 用とは別)
  const prevPosForDistanceRef = useRef<{ lat: number; lon: number } | null>(null)
  // localStorage key ヘルパ
  const unitDistKey = (assignmentId: string) =>
    `mobility:unitDist:${assignmentId}`
  const todayDistKey = (uid: string, ymd: string) =>
    `mobility:todayDist:${uid}:${ymd}`
  const todayYmd = () => {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

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

  // ロック画面 / Dynamic Island の表示を更新する。
  // 行き先とセクション走行距離が分かれば運転中は足りる (速度は載せない)。
  useEffect(() => {
    if (!myActive) {
      // 降車したら消す。watcher の停止任せだと消え残ることがある
      void endLiveActivity()
      return
    }
    void updateLiveActivity({
      destinationName: selectedDestination?.name ?? null,
      distanceKm: unitDistanceM / 1000,
      pendingCount: queueLen,
      online: isOnline,
    })
  }, [myActive, selectedDestination, unitDistanceM, queueLen, isOnline])

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
    void getQueueLength(user.id).then(setQueueLen)
  }, [user])

  // 地図追跡状態 (現在地に自動でセンタリング)。初期値 true。
  // ユーザーが地図をドラッグすると false になり、現在地ボタンで戻す。
  const [followMe, setFollowMe] = useState(true)
  // ヘディングアップ (地図を進行方向に回転)。初期値 false = 北向き。
  const [headingUp, setHeadingUp] = useState(false)
  // 走行軌跡の点表示 (現在走行中の trackPositions を CircleMarker で描画)
  const [showTrackPoints, setShowTrackPoints] = useState(false)
  // 直前に自分で setView した直後は dragstart ハンドラを 1 tick 抑制するフラグ
  const ignoreNextGestureRef = useRef(false)

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

  /** 前回 送信した 地点。停止判定 (距離) に 使う */
  const lastSentPosRef = useRef<{ lat: number; lon: number } | null>(null)
  const sendPositionRef = useRef(sendPositions)
  useEffect(() => {
    sendPositionRef.current = sendPositions
  }, [sendPositions])

  // 走行軌跡 (自分の active assignment の位置ログ)。
  // - 初回 or myActive 変化時に fetchRecentPositions で 200 点 fetch
  // - その後は GPS ping 受信ごとに client 側で追加 (real-time)
  const [trackPositions, setTrackPositions] = useState<MobilityPosition[]>([])

  // ping 送信時に client 側 trackPositions にも即時追加するヘルパ。
  // 5000点上限 (~1.4h @ 1Hz) で古い側を捨てる。
  // 負値の id を使ってサーバ ID (bigserial) と衝突を回避。
  const appendLocalTrack = useCallback(
    (assignmentId: string, sample: {
      lat: number
      lon: number
      accuracy_m: number | null
      speed_kmh: number | null
      heading_deg: number | null
      altitude_m: number | null
    }) => {
      const nowMs = Date.now()
      const row: MobilityPosition = {
        id: -nowMs,
        assignment_id: assignmentId,
        recorded_at: new Date(nowMs).toISOString(),
        lat: sample.lat,
        lon: sample.lon,
        accuracy_m: sample.accuracy_m,
        speed_kmh: sample.speed_kmh,
        heading_deg: sample.heading_deg,
        altitude_m: sample.altitude_m,
      }
      setTrackPositions((prev) => {
        const next = [...prev, row]
        return next.length > 5000 ? next.slice(-5000) : next
      })
    },
    [],
  )

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
      // IndexedDB への 書き込みは 非同期。await しないと flush が 先に走って
      // 直前の ping を 取りこぼす
      await enqueuePing(uid, {
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
      const before = await getQueueLength(user.id)
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
      const before = await getQueueLength(user.id)
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
  // 依存は autoSend (= 乗車中かの 真偽) だけに 絞る。
  // myActive / myVehicle は 取得の たびに 新しい オブジェクトに なるため、
  // deps に 入れると activeAssignments の 定期取得の たびに watcher を
  // 張り直して しまう。バックグラウンドでは 張り直しの 度に 位置更新が
  // 途切れ、結果として 一度も 届かないことが ある。
  // (このファイル冒頭の「ref に逃がして watch を再登録しない」方針の 徹底)
  const myVehicleNameRef = useRef<string | null>(null)
  useEffect(() => {
    myVehicleNameRef.current = myVehicle?.name ?? null
  }, [myVehicle])
  useEffect(() => {
    if (!autoSend) return
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
            if (
              !shouldSendNow(
                now,
                lastSentAtRef.current,
                lastSentPosRef.current,
                sample,
                haversineMeters,
              )
            ) {
              return
            }
            lastSentAtRef.current = now
            lastSentPosRef.current = { lat: sample.lat, lon: sample.lon }
            setLastAutoSentAt(new Date(now))
            const payload = {
              lat: sample.lat,
              lon: sample.lon,
              accuracy_m: sample.accuracy_m,
              speed_kmh: sample.speed_kmh,
              heading_deg: sample.heading_deg,
              altitude_m: sample.altitude_m,
            }
            // 送信と同時に client 側 trackPositions にも追加 (real-time 表示)
            appendLocalTrack(active.id, payload)
            void sendWithQueue(active.id, payload)
          },
          {
            notificationTitle: 'NodeCloudモビリティ',
            notificationBody: `${myVehicleNameRef.current ?? '車両'} の現在地を送信中`,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend])

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

            // 距離をクライアント側で累算 + localStorage 永続化。
            // オフラインでも進み、アプリ再起動しても復元される。
            // 停車ジッタを避けて 1m〜2000m の segment だけ加算。
            // 精度が悪い読み (accuracy > 50m) は除外。
            {
              const prev = prevPosForDistanceRef.current
              const cur = { lat: sample.lat, lon: sample.lon }
              const accOk =
                sample.accuracy_m == null || sample.accuracy_m <= 50
              if (prev && accOk) {
                const seg = haversineMeters(prev, cur)
                if (seg >= 1 && seg <= 2000) {
                  setUnitDistanceM((v) => {
                    const next = v + seg
                    try {
                      localStorage.setItem(unitDistKey(active.id), String(next))
                    } catch {
                      /* noop */
                    }
                    return next
                  })
                  const uid = userIdRef.current
                  setTodayDistanceM((v) => {
                    const next = v + seg
                    if (uid) {
                      try {
                        localStorage.setItem(
                          todayDistKey(uid, todayYmd()),
                          String(next),
                        )
                      } catch {
                        /* noop */
                      }
                    }
                    return next
                  })
                  prevPosForDistanceRef.current = cur
                }
              } else if (accOk) {
                prevPosForDistanceRef.current = cur
              }
            }

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
            if (
              !shouldSendNow(
                now,
                lastSentAtRef.current,
                lastSentPosRef.current,
                sample,
                haversineMeters,
              )
            ) {
              return
            }
            lastSentAtRef.current = now
            lastSentPosRef.current = { lat: sample.lat, lon: sample.lon }
            setLastAutoSentAt(new Date(now))
            const payload = {
              lat: sample.lat,
              lon: sample.lon,
              accuracy_m: sample.accuracy_m,
              speed_kmh: sample.speed_kmh,
              heading_deg: sample.heading_deg,
              altitude_m: sample.altitude_m,
            }
            // 送信と同時に client 側 trackPositions にも追加 (real-time 表示)
            appendLocalTrack(active.id, payload)
            void sendWithQueue(active.id, payload)
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
  // セクション距離: localStorage から復元。無ければサーバから 1 度だけ fetch。
  useEffect(() => {
    if (!user || !myActive) {
      setUnitDistanceM(0)
      prevPosForDistanceRef.current = null
      return
    }
    prevPosForDistanceRef.current = null
    const key = unitDistKey(myActive.id)
    const saved = localStorage.getItem(key)
    if (saved != null) {
      const parsed = parseFloat(saved)
      setUnitDistanceM(Number.isFinite(parsed) ? parsed : 0)
      return
    }
    // localStorage が空 (別端末で乗車開始した場合など) → サーバ fetch フォールバック
    let cancelled = false
    void (async () => {
      const rows = await fetchPositionsForUserSince(user.id, myActive.started_at)
      if (cancelled) return
      const m = computeTotalDistanceMeters(rows)
      setUnitDistanceM(m)
      try {
        localStorage.setItem(key, String(m))
      } catch {
        /* quota 等は無視 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, myActive, fetchPositionsForUserSince])

  // 本日走行距離: localStorage (日付キー) から復元。無ければサーバから 1 度だけ fetch。
  useEffect(() => {
    if (!user) {
      setTodayDistanceM(0)
      return
    }
    const ymd = todayYmd()
    const key = todayDistKey(user.id, ymd)
    const saved = localStorage.getItem(key)
    if (saved != null) {
      const parsed = parseFloat(saved)
      setTodayDistanceM(Number.isFinite(parsed) ? parsed : 0)
      return
    }
    let cancelled = false
    void (async () => {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const rows = await fetchPositionsForUserSince(
        user.id,
        startOfToday.toISOString(),
      )
      if (cancelled) return
      const m = computeTotalDistanceMeters(rows)
      setTodayDistanceM(m)
      try {
        localStorage.setItem(key, String(m))
      } catch {
        /* noop */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, fetchPositionsForUserSince])

  // セクション走行時間 (myActive.started_at から現在まで)。
  // 本日走行の合計時間は現行 UI では表示していないため計算しない。
  const unitDurationMs = myActive
    ? Math.max(0, nowTick - new Date(myActive.started_at).getTime())
    : 0

  // 走行軌跡の初期化: 乗車開始 or アプリ再開時に server から fetch。
  // その後は appendLocalTrack が GPS ping ごとに client-side で追加していく。
  useEffect(() => {
    if (!myActive) {
      setTrackPositions([])
      return
    }
    let cancelled = false
    void (async () => {
      const rows = await fetchRecentPositions(myActive.id, 500)
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
  // 行き先を決めたら出発報告を促す。
  // フックは早期 return より前に置く必要があるので、距離は destInfo (後段の
  // useMemo) に頼らずここで求める
  useEffect(() => {
    if (!myActive || !selectedDestination) return
    if (departNotifiedRef.current === selectedDestination.id) return
    departNotifiedRef.current = selectedDestination.id
    arriveNotifiedRef.current = null
    setNotePrompt(`${selectedDestination.name} に向かいます。`)
  }, [myActive, selectedDestination])

  // 目的地に近づいたら到着報告を促す
  useEffect(() => {
    if (!myActive || !selectedDestination || !currentPos) return
    const d = haversineMeters(
      { lat: currentPos[0], lon: currentPos[1] },
      { lat: selectedDestination.lat, lon: selectedDestination.lon },
    )
    if (d > ARRIVAL_RADIUS_M) return
    if (arriveNotifiedRef.current === selectedDestination.id) return
    arriveNotifiedRef.current = selectedDestination.id
    setNotePrompt(`${selectedDestination.name} に到着しました。`)
  }, [myActive, selectedDestination, currentPos])

  const [showPcWarning, setShowPcWarning] = useState(
    () => !isMobileDevice() && !isMobilityApp(),
  )

  const handleSignOut = async () => {
    if (myActive && !confirm('乗車中です。ログアウトしても位置の送信は止まりません。降車してからログアウトしますか?\n\nOK = このままログアウト / キャンセル = 中止')) {
      return
    }
    await signOut()
  }

  // 乗車したら履歴の表示を片付ける。走行中の地図に過去の軌跡が残っていると
  // 現在地と見分けがつかない
  useEffect(() => {
    if (!myActive) return
    setShowLogsSheet(false)
    setSelectedLogSection(null)
    setSelectedLogPositions([])
  }, [myActive])

  /** 乗車前に選んだ目的地。乗車が済んだ時点で適用する */
  const [pendingDestination, setPendingDestination] = useState<MobilityProjectPoint | null>(
    null,
  )

  const handleBoard = async (vehicleId: string) => {
    // 同一ユーザーが 2 台に 乗るのは 不整合。既に 乗車中なら 何もしない
    // (通常は 乗車ボタン自体が 出ないが、通信断からの 復帰時などに 備える)
    if (myActive && myActive.vehicle_id !== vehicleId) {
      setShowPicker(false)
      return
    }
    if (myActive && myActive.vehicle_id === vehicleId) {
      setShowPicker(false)
      return
    }
    setBusyError(null)
    setBusy(true)
    try {
      const res = await startAssignment(vehicleId)
      if (!res) throw new Error(useMobilityStore.getState().vehiclesError ?? '開始に失敗')
      // 次回の乗車で先頭に出すため、直近の車両を覚えておく
      try {
        localStorage.setItem(LAST_VEHICLE_KEY, vehicleId)
      } catch {
        /* localStorage 拒否環境 */
      }
      // 「目的地 → 乗車」の順で操作した場合、ここで目的地を適用する。
      // myActive はストア更新待ちなので、返ってきた assignment の id を直接使う
      if (pendingDestination) {
        await setAssignmentDestination(res.id, pendingDestination.id)
        setPendingDestination(null)
        if (orgId) await fetchActiveAssignments(orgId)
      }
      setShowPicker(false)
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
    } catch (err) {
      setBusyError(friendlyMobilityError(err))
    } finally {
      setBusy(false)
    }
  }

  if (!canUse) return <Navigate to="/" replace />

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
    // 下端の セーフエリアは ルートではなく フッタに 持たせる。
    // ルートに padding-bottom を 置くと フッタの 背景が ホームインジケータの
    // 手前で 途切れ、その下に 地の色が 見えて 「切れている」ように 見える。
    <div
      className="flex flex-col bg-slate-900 relative"
      style={{
        height: '100dvh',
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        boxSizing: 'border-box',
      }}
    >
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
        <div className="text-base font-bold flex-1 min-w-0 truncate">
          {isMobilityAppFlag ? 'NodeCloudモビリティ' : 'NodeCloud'}
        </div>
        {locationError && (
          <span className="text-[10px] text-amber-300 max-w-[8rem] text-right leading-tight">
            {locationError}
          </span>
        )}
        {/* 右端: ログイン名 + ログアウト。専用アプリは他に画面が無く、
            ここ以外にログアウトの導線が無い */}
        {user && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-slate-300 max-w-[7rem] truncate">
              {displayName || user.email}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              className="p-1.5 rounded hover:bg-slate-700 text-slate-300"
              title="ログアウト"
              aria-label="ログアウト"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
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
      {/* 車両バー。未乗車でも下のパネルは出るので、ここが消えると
          「何の状態か」が分からなくなる。未乗車の旨を出しておく */}
      <div className="px-3 py-1.5 bg-slate-700 text-white flex items-center gap-2 shrink-0 text-xs">
        <Car
          className={`h-4 w-4 shrink-0 ${myActive ? 'text-indigo-300' : 'text-slate-400'}`}
        />
        {myActive && myVehicle ? (
          <>
            <span className="font-semibold truncate">{myVehicle.name}</span>
            <span className="text-slate-300 shrink-0">
              · {KIND_LABEL[myVehicle.kind]} · 稼働中
            </span>
          </>
        ) : (
          <span className="text-slate-300">未乗車 · 位置は送信していません</span>
        )}
      </div>

      {/* 速度・セクション距離・行き先パネル (常に 3 列)。
          未乗車でも速度は出したい (現在地確認や動作確認に使う) ので、
          乗車状態で出し分けせず常に表示する。乗車が要る操作だけ内側で抑える */}
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
            {distanceMode === 'unit' && myActive && (
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
              title={
                myActive ? 'タップで行き先を選ぶ' : 'タップで行き先を選ぶ (選択後に車両を選びます)'
              }
            >
              <div className="text-[10px] flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span>行き先</span>
              </div>
              <div className="text-sm font-medium leading-tight mt-1">未設定</div>
              <div className="text-[9px] text-slate-500 mt-0.5">
                {myActive ? 'タップで選択' : '選んでから乗車'}
              </div>
            </button>
          )}
      </div>

      {/* 地図 */}
      <div className="flex-1 relative">
        <MapContainer
          center={[35.681236, 139.767125]}
          zoom={15}
          zoomControl={false}
          className="h-full w-full"
          // 長押し → contextmenu の擬似発火。Capacitor の WKWebView は UA に
          // "Safari" を含まず Leaflet の既定判定から漏れるため明示 ON。
          // (ICT 側 MobileStakingPage と同じ理由)
          tapHold
          {...({ rotate: true, bearing: 0, rotateControl: false } as Record<string, unknown>)}
        >
          {/* 走った場所を自動でキャッシュする。圏外でも直前に通った範囲は出る。
              保存は「乗車中 × 現在地の近く」に限るので、地図を眺めただけでは
              貯まらない */}
          <CachedTileLayer
            layerId={baseLayer}
            attribution={BASE_LAYERS[baseLayer].attribution}
            url={BASE_LAYERS[baseLayer].url}
            maxNativeZoom={BASE_LAYERS[baseLayer].maxNative}
            maxZoom={22}
            currentPos={currentPos}
            cacheEnabled={!!myActive}
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
          <MapLongPressHandler
            onLongPress={(lat, lon) => {
              setPointRegisterDialog({ lat, lon })
            }}
          />
          <MapBearingUpdater enabled={headingUp} heading={currentHeadingDeg} />
          {/* 走行軌跡: 各 ping を点で表示 (MapControlStack のトグルで ON/OFF)。
              polyline は描かず点のみ。GPS ping 到達ごとに client-side で
              リアルタイム追加される。 */}
          {showTrackPoints &&
            trackPositions.map((p) => (
              <CircleMarker
                key={`tp-${p.id}`}
                center={[p.lat, p.lon]}
                radius={3}
                pathOptions={{
                  color: '#4338ca',
                  fillColor: '#a5b4fc',
                  fillOpacity: 0.9,
                  weight: 1,
                }}
              />
            ))}
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
          {/* 登録済みポイント。タップで目的地に設定できる。
              現在の目的地は下の専用マーカーで描くのでここでは除く */}
          {allPoints
            .filter((p) => p.id !== selectedDestination?.id)
            .map((p) => (
              <Marker
                key={p.id}
                position={[p.lat, p.lon]}
                icon={buildProjectPointIcon(p.name)}
                eventHandlers={{ click: () => setPointActionTarget(p) }}
              />
            ))}
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
          {/* 表示中の範囲を事前に保存する。初めて行く場所の備え */}
          <SaveViewButton
            url={BASE_LAYERS[baseLayer].url}
            layerId={baseLayer}
            onDone={() => void tileUsage().then((u) => setTileMB(u.bytes / 1024 / 1024))}
          />
          <MapControlStack
            followMe={followMe}
            headingUp={headingUp}
            showTrackPoints={showTrackPoints}
            onToggleFollow={() => {
              // OFF → ON にする時は即センタリング
              setFollowMe((prev) => !prev)
            }}
            onToggleHeading={() => setHeadingUp((prev) => !prev)}
            onToggleTrackPoints={() => setShowTrackPoints((prev) => !prev)}
          />
          {/* 背景地図セレクタ (右下、Leaflet の帰属表示の上)。
              保存済み地図の容量もここに出す。専用の設定画面は作らない
              (ドライバーに管理させない方針) */}
          <div className="absolute bottom-5 right-1 z-[1000] flex items-center gap-1 px-1.5 py-0.5 rounded shadow border border-slate-600 bg-slate-900/90 text-[11px] text-slate-200">
            {tileMB != null && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`保存した地図 ${tileMB.toFixed(1)}MB を削除しますか?\n圏外では地図が出なくなります。`)) return
                  await tileClear()
                  setTileMB(0)
                }}
                className="text-slate-400 hover:text-slate-200"
                title="保存した地図を削除"
              >
                地図 {tileMB.toFixed(0)}MB
              </button>
            )}
            <span className="text-slate-400">背景</span>
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as BaseLayerKey)}
              className="bg-transparent outline-none"
            >
              {(Object.keys(BASE_LAYERS) as BaseLayerKey[]).map((k) => (
                <option key={k} value={k} className="text-slate-900">
                  {BASE_LAYERS[k].label}
                </option>
              ))}
            </select>
          </div>
        </MapContainer>
      </div>

      {/* 報告の下書き。文章はこちらで用意し、送るかどうかはドライバーが決める。
          走行中に文字を打たせないための仕組みなので、勝手には送らない */}
      {notePrompt && myActive && (
        <div className="mx-3 mt-2 p-2 rounded-lg bg-sky-950/60 border border-sky-700 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-sky-300 shrink-0" />
          <span className="flex-1 min-w-0 text-xs text-sky-100 truncate">{notePrompt}</span>
          <button
            type="button"
            onClick={() => setNotePrompt(null)}
            className="shrink-0 px-2 py-1.5 text-xs rounded text-sky-300 hover:bg-sky-900/60"
          >
            送らない
          </button>
          <button
            type="button"
            disabled={noteSending}
            onClick={async () => {
              if (!orgId || !user) return
              setNoteSending(true)
              try {
                await sendNote({
                  organizationId: orgId,
                  channelKind: 'direct',
                  channelUserId: user.id,
                  channelProjectId: null,
                  senderRole: 'driver',
                  body: notePrompt,
                })
                setNotePrompt(null)
              } finally {
                setNoteSending(false)
              }
            }}
            className="shrink-0 flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded bg-sky-600 text-white disabled:opacity-50"
          >
            {noteSending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            送信
          </button>
        </div>
      )}

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

      {/* フッタアクション。背景を 下端まで 伸ばしつつ、中身は
          ホームインジケータに かからないよう セーフエリア分 下に 余白を 取る */}
      <div
        className="p-3 bg-slate-800 flex flex-col gap-2 shrink-0"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2">
          {/* 運行履歴ボタンは一時的に非表示 (メッセージを全幅で使うため)。
              シート本体と取得処理は残してあるので、戻すときはこのボタンだけ復活させる */}
          {/* メッセージ。ラベルではなく最新の受信内容を出す。
              未読があれば色を変えて点滅させ、開かなくても気づけるようにする */}
          <button
            type="button"
            onClick={() => setShowChatSheet({ kind: 'direct', label: '管理者' })}
            className={`relative flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-sm rounded-lg border ${
              hasUnreadIncoming
                ? 'border-amber-400 bg-amber-500/20 text-amber-100 animate-pulse'
                : 'border-emerald-500 text-emerald-200 hover:bg-emerald-950/40'
            }`}
          >
            {/* アイコンは右のチャットボタンにあるので、ここには置かない。
                そのぶん本文に幅を使う。
                2 行まで出す。1 行だと「〇〇さん、△△に向かってください」が
                途中で切れて用件が読めない */}
            <span
              className="flex-1 min-w-0 text-left leading-snug"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {latestIncoming && (
                <span className="opacity-70">
                  {latestSenderName || (latestIncoming.sender_role === 'admin' ? '管理者' : '')}
                  {(latestSenderName || latestIncoming.sender_role === 'admin') && ': '}
                </span>
              )}
              {latestIncoming
                ? latestIncoming.body?.trim() ||
                  (latestIncoming.message_kind === 'instruction' ? '運行指示' : 'メッセージ')
                : 'メッセージ'}
            </span>
            {unreadInstructionCount > 0 && (
              <span className="shrink-0 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
                {unreadInstructionCount}
              </span>
            )}
          </button>
          {/* 上のボタンは指示を受けると行き先選択へ飛ぶので、会話そのものへの
              入口をここに残す (運行履歴ボタンを消した今、他に導線が無い) */}
          <button
            type="button"
            onClick={() => setShowChatSheet({ kind: 'direct', label: '管理者' })}
            className="shrink-0 px-3 rounded-lg border border-emerald-500 text-emerald-200 hover:bg-emerald-950/40 flex items-center"
            title="メッセージ一覧を開く"
            aria-label="メッセージ一覧を開く"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        </div>
        {myActive ? (
          <div className="flex gap-2">
            {/* 送信ステータス表示。乗車中は 常に 送るので トグルは 置かない
                (止めたい時は 降車する)。
                経路案内は別ボタンに切り出した。押す意味が違うものを 1 つに
                まとめると、送信状態を見たいだけで地図アプリに飛ばされる */}
            <div className="flex-1 min-h-[3.5rem] flex flex-col items-center justify-center gap-0.5 px-3 py-2 text-base font-semibold rounded-lg bg-emerald-600 text-white">
              <span className="flex items-center gap-2">
                <Navigation className="h-4 w-4" />
                位置を送信中
              </span>
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
                      : `送信中${
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
            </div>
            {/* 経路案内 (黄色)。行き先があるときだけ押せる */}
            <button
              type="button"
              disabled={!selectedDestination}
              onClick={() => {
                if (!selectedDestination) return
                const url =
                  'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
                  `${selectedDestination.lat},${selectedDestination.lon}`
                window.open(url, '_blank')
              }}
              style={{ touchAction: 'manipulation' }}
              className="shrink-0 min-h-[3.5rem] flex flex-col items-center justify-center px-3 py-2 text-sm font-semibold rounded-lg bg-amber-500 text-slate-900 disabled:opacity-40"
              title={
                selectedDestination
                  ? `${selectedDestination.name} へのルートを Google マップで開く`
                  : '行き先を設定すると使えます'
              }
            >
              <span className="flex items-center gap-1">
                <Navigation className="h-4 w-4" />
                経路案内
              </span>
              <span className="text-[10px] font-normal leading-tight">Google マップ</span>
            </button>
            <button
              type="button"
              onClick={handleLeave}
              disabled={busy}
              style={{ touchAction: 'manipulation' }}
              className="shrink-0 min-h-[3.5rem] flex items-center gap-1 px-4 py-3 text-sm font-semibold border border-red-500 bg-red-950/40 text-red-200 rounded-lg active:bg-red-900/60 disabled:opacity-50"
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
            className="flex-1 min-h-[3.5rem] flex items-center justify-center gap-2 px-3 py-3 text-base font-semibold bg-indigo-600 text-white rounded-lg disabled:opacity-50"
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
          currentUserId={user?.id ?? null}
          lastVehicleId={(() => {
            try {
              return localStorage.getItem(LAST_VEHICLE_KEY)
            } catch {
              return null
            }
          })()}
          destinationName={pendingDestination?.name ?? null}
          onPick={handleBoard}
          onClose={() => {
            setShowPicker(false)
            setPendingDestination(null)
          }}
        />
      )}

      {showDestSheet && (
        <DestinationPickerSheet
          projects={myProjects}
          currentPos={currentPos}
          fetchProjectPoints={fetchProjectPoints}
          initialPoint={destInitialPoint}
          busy={destBusy}
          error={destError}
          onConfirm={async (point) => {
            if (!myActive) {
              // 未乗車: 目的地を控えたまま車両選択へ進む。
              // 乗車できた時点で handleBoard が適用する
              setPendingDestination(point)
              setShowDestSheet(false)
              setShowPicker(true)
              return
            }
            const ok = await applyDestination(point)
            if (ok) setShowDestSheet(false)
          }}
          onClear={async () => {
            if (!myActive) {
              // 未乗車では控えている分を取り消すだけ
              setPendingDestination(null)
              setShowDestSheet(false)
              return
            }
            const ok = await applyDestination(null)
            if (ok) setShowDestSheet(false)
          }}
          onClose={() => {
            setShowDestSheet(false)
            setDestInitialPoint(null)
          }}
        />
      )}

      {/* 地図のポイントをタップ → 目的地に設定 */}
      {pointActionTarget && (
        <PointActionSheet
          point={pointActionTarget}
          projectName={
            orgProjects.find((pr) => pr.id === pointActionTarget.project_id)?.name ?? null
          }
          canSetDestination={!!myActive}
          onClose={() => setPointActionTarget(null)}
          onSetDestination={async () => {
            const p = pointActionTarget
            setPointActionTarget(null)
            await applyDestination(p)
          }}
          onBoardThenSetDestination={() => {
            // 目的地 → 乗車 の順。乗車が済んだ時点で handleBoard が適用する
            setPendingDestination(pointActionTarget)
            setPointActionTarget(null)
            setShowPicker(true)
          }}
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
          selected={showChatSheet}
          activeAssignmentId={myActive?.id ?? null}
          currentLat={currentPos?.[0] ?? null}
          currentLon={currentPos?.[1] ?? null}
          onConfirmed={async (_assignmentId, pointId) => {
            if (orgId) await fetchActiveAssignments(orgId)
            // 指示を確認したら行き先の確定画面へ進む。地図で場所と距離を
            // 確かめてから確定できるようにする (ここでは設定しない)。
            const pt = pointById(pointId)
            if (pt) {
              setShowChatSheet(null)
              setDestInitialPoint(pt)
              setShowDestSheet(true)
            }
          }}
          onArrived={async () => {
            if (orgId) await fetchActiveAssignments(orgId)
          }}
          onClose={() => setShowChatSheet(null)}
        />
      )}

      {pointRegisterDialog && (
        <PointRegisterDialog
          lat={pointRegisterDialog.lat}
          lon={pointRegisterDialog.lon}
          projects={orgProjects}
          onClose={() => setPointRegisterDialog(null)}
          onCreated={() => {
            setPointRegisterDialog(null)
            // 作った直後に地図へ出す。再取得しないと画面を開き直すまで見えない
            void reloadAllPoints()
          }}
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
  activeAssignmentId,
  currentLat,
  currentLon,
  onConfirmed,
  onArrived,
  onClose,
}: {
  organizationId: string
  myUserId: string
  selected: { kind: 'direct'; label: string }
  activeAssignmentId: string | null
  currentLat: number | null
  currentLon: number | null
  onConfirmed: (assignmentId: string | null, pointId: string | null) => Promise<void>
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
          <h3 className="text-base font-semibold flex-1">管理者とやり取り</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 p-2">
          <MobilityChatPanel
            organizationId={organizationId}
            channelKind="direct"
            channelUserId={myUserId}
            channelProjectId={null}
            senderRole="driver"
            showDriverConfirm
            activeAssignmentId={activeAssignmentId}
            currentLat={currentLat}
            currentLon={currentLon}
            onConfirmed={(assignmentId, pointId) => void onConfirmed(assignmentId, pointId)}
            onArrived={() => void onArrived()}
          />
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// ドライバー用ポイント登録ダイアログ (地図長押しから起動)
// - 現場を選択 (未分類がデフォルト)
// - 名前 + メモを入力して INSERT
// - RLS: mobility_project_points_insert 緩和で org member なら誰でも作成可能
// -----------------------------------------------------------------------------
function PointRegisterDialog({
  lat,
  lon,
  projects,
  onClose,
  onCreated,
}: {
  lat: number
  lon: number
  projects: MobilityProject[]
  onClose: () => void
  onCreated: () => void
}) {
  // 「未分類」があればそれを既定に、無ければ先頭
  const defaultProjectId =
    projects.find((p) => p.name === '未分類')?.id ?? projects[0]?.id ?? ''
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [name, setName] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createPoint = useMobilityStore((s) => s.createPoint)
  const canSubmit = !busy && projectId && name.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-[3500] bg-black/60 flex items-end sm:items-center justify-center p-2"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-5 w-5 text-amber-600" />
          <h3 className="text-base font-semibold flex-1">ポイントを登録</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="text-[11px] text-slate-500 mb-3 font-mono">
          {lat.toFixed(6)}, {lon.toFixed(6)}
        </div>

        <div className="space-y-3">
          <label className="block">
            <div className="text-xs font-medium text-slate-600 mb-1">
              現場
            </div>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <div className="text-xs font-medium text-slate-600 mb-1">
              ポイント名 <span className="text-red-500">*</span>
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 土取場入口"
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </label>

          <label className="block">
            <div className="text-xs font-medium text-slate-600 mb-1">
              メモ (任意)
            </div>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={2}
              className="w-full px-2 py-1.5 text-sm border rounded resize-none"
            />
          </label>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!canSubmit) return
                setBusy(true)
                setError(null)
                try {
                  const created = await createPoint({
                    project_id: projectId,
                    name: name.trim(),
                    lat,
                    lon,
                    memo: memo.trim() || null,
                  })
                  if (!created) throw new Error('作成に失敗しました')
                  onCreated()
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
              disabled={!canSubmit}
              className="flex-1 px-3 py-2 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-1"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              登録
            </button>
          </div>
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
  initialPoint,
  busy,
  error,
  onConfirm,
  onClear,
  onClose,
}: {
  projects: MobilityProject[]
  currentPos: [number, number] | null
  fetchProjectPoints: (projectId: string) => Promise<MobilityProjectPoint[]>
  /** 指示で行き先が決まっている場合、この地点の確定画面から開く */
  initialPoint: MobilityProjectPoint | null
  busy: boolean
  error: string | null
  onConfirm: (point: MobilityProjectPoint) => void | Promise<void>
  onClear: () => void | Promise<void>
  onClose: () => void
}) {
  // 指示で行き先が決まっている場合は、カテゴリ・ポイントを選び直させず
  // 確定画面から始める
  const [step, setStep] = useState<'projects' | 'points' | 'preview'>(
    initialPoint ? 'preview' : 'projects',
  )
  const [selectedProject, setSelectedProject] = useState<MobilityProject | null>(null)
  const [points, setPoints] = useState<MobilityProjectPoint[]>([])
  const [loadingPoints, setLoadingPoints] = useState(false)
  const [pointsError, setPointsError] = useState<string | null>(null)
  const [previewPoint, setPreviewPoint] = useState<MobilityProjectPoint | null>(
    initialPoint ?? null,
  )

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
            {step === 'projects' && 'カテゴリを選ぶ'}
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
                  割り当てられたカテゴリがありません
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

/** 地図上のポイントをタップしたときの操作シート */
function PointActionSheet({
  point,
  projectName,
  canSetDestination,
  onClose,
  onSetDestination,
  onBoardThenSetDestination,
}: {
  point: MobilityProjectPoint
  projectName: string | null
  canSetDestination: boolean
  onClose: () => void
  onSetDestination: () => void | Promise<void>
  /** 未乗車のとき、この地点を控えて車両選択へ進む */
  onBoardThenSetDestination: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-end z-[9999]" onClick={onClose}>
      <div
        className="bg-white w-full rounded-t-2xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold truncate">{point.name}</h3>
            {projectName && (
              <div className="text-[11px] text-slate-500 truncate">{projectName}</div>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        {canSetDestination ? (
          <button
            type="button"
            onClick={() => void onSetDestination()}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-lg font-bold"
          >
            <Navigation className="h-5 w-5" />
            ここを目的地にする
          </button>
        ) : (
          // 未乗車でも操作を止めない。この地点を控えたまま車両選択へ進み、
          // 乗車できた時点で目的地に設定する
          <button
            type="button"
            onClick={onBoardThenSetDestination}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-lg font-bold"
          >
            <Play className="h-5 w-5" />
            乗車してここを目的地にする
          </button>
        )}
      </div>
    </div>
  )
}

/** 登録済みポイントのマーカー (青ピン + 名前) */
function buildProjectPointIcon(name: string): L.DivIcon {
  const label = name.replace(/[&<>]/g, '')
  return L.divIcon({
    className: 'mobility-project-point-icon',
    html:
      '<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-50%)">' +
      '<div style="background:#2563eb;border:2px solid #fff;border-radius:50%;width:14px;height:14px;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>' +
      '<div style="margin-top:2px;padding:1px 4px;background:rgba(255,255,255,.9);border-radius:3px;' +
      'font-size:10px;font-weight:600;color:#1e3a8a;white-space:nowrap">' +
      label +
      '</div></div>',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

function VehiclePickerSheet({
  vehicles,
  activeAssignments,
  currentUserId,
  lastVehicleId,
  destinationName,
  onPick,
  onClose,
}: {
  vehicles: Vehicle[]
  activeAssignments: Map<string, { id: string; driver_name: string | null; user_id: string }>
  currentUserId: string | null
  /** 直近に乗車した車両。先頭に出す */
  lastVehicleId: string | null
  /** 先に選んだ目的地があれば見出しに出す (目的地 → 乗車 の順に対応) */
  destinationName: string | null
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
          <div className="min-w-0">
            <h3 className="text-base font-semibold">乗車する車両を選ぶ</h3>
            {destinationName && (
              <div className="text-[11px] text-amber-700 truncate">
                行き先: {destinationName}（乗車後に設定します）
              </div>
            )}
          </div>
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
              {[...vehicles]
                .sort((a, b) => {
                  // 直近に乗った車両を先頭に。毎回同じ車に乗る運用が多く、
                  // 一覧から探す手間を省く
                  if (a.id === lastVehicleId) return -1
                  if (b.id === lastVehicleId) return 1
                  return 0
                })
                .map((v) => {
                const active = activeAssignments.get(v.id)
                // 自分が 乗車中の 車両は 「使用中」で 塞がない。
                // 通信断で 一時的に 乗車状態を 見失った後、自分の車に 戻れなく
                // なるため (DB 側の assignment は 開いたまま)。
                const busyBy =
                  active && currentUserId && active.user_id === currentUserId ? null : active
                const isMine = !!active && !busyBy
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
                      {v.id === lastVehicleId && !isMine && !busyBy && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-slate-100 text-slate-600 border border-slate-300">
                          前回
                        </span>
                      )}
                      {isMine && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                          自分が乗車中
                        </span>
                      )}
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
