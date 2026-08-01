// 稼働中車両を地図上に描くビュー (単独ページ用ではなく組込コンポーネント)。
//
// - 組織内の active assignment × 最新位置をマーカー表示
// - Supabase Realtime で mobility_positions INSERT を購読
// - onMarkerClick で親コンポーネントに車両クリックを通知

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MapContainer,
  Marker,
  TileLayer,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import { VehicleMarker } from '@/features/mobility/VehicleMarker'
import L, { type LatLngBoundsExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, RotateCcw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useMobilityStore } from '@/stores/mobilityStore'
import { bearingLabel, bearingDeg, haversineMeters } from '@/lib/geoDistance'
import type { MobilityPosition, MobilityProjectPoint } from '@/types/database'

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

// 目的地ピン (吹き出しに名称)。オレンジで統一。
// iconAnchor をボックス下端中央にすることで pin の tip が緯度経度に刺さる。
const DEST_ICON_W = 220
const DEST_ICON_TAIL_H = 8
const DEST_ICON_BODY_H = 22
const DEST_ICON_H = DEST_ICON_BODY_H + DEST_ICON_TAIL_H

function buildDestinationIcon(name: string): L.DivIcon {
  const safe = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const html = `
    <div style="width:${DEST_ICON_W}px;height:${DEST_ICON_H}px;overflow:visible;pointer-events:none;text-align:center;">
      <div style="display:inline-block;background:#f59e0b;color:#111827;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.5);max-width:${DEST_ICON_W - 8}px;overflow:hidden;text-overflow:ellipsis;line-height:${DEST_ICON_BODY_H - 6}px;">🚩 ${safe}</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:${DEST_ICON_TAIL_H}px solid #f59e0b;margin:0 auto;"></div>
    </div>`
  return L.divIcon({
    className: 'mobility-destination-icon',
    html,
    iconSize: [DEST_ICON_W, DEST_ICON_H],
    iconAnchor: [DEST_ICON_W / 2, DEST_ICON_H],
  })
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`
}

// 経過時間を "N分前" / "N時間前" などの短い日本語ラベルに
export function formatAgeShort(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分前`
  const h = Math.floor(m / 60)
  return `${h}時間前`
}

// 運行現場ポイント用 (青ピン)。編集中は赤にハイライト。
function projectPointIcon(highlight: boolean): L.DivIcon {
  const color = highlight ? '#dc2626' : '#6366f1'
  return L.divIcon({
    className: 'mobility-point-marker',
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34" style="overflow:visible;">
      <path d="M14 0 C6 0 0 6 0 14 C0 24 14 34 14 34 C14 34 28 24 28 14 C28 6 22 0 14 0 Z"
            fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="13" r="5" fill="white"/>
    </svg>`,
    iconSize: [28, 34],
    iconAnchor: [14, 34],
  })
}

// 地図クリックを親に通知する (addPointMode 中のみ)
function MapClickHandler({
  enabled,
  onClick,
}: {
  enabled: boolean
  onClick: (lat: number, lon: number) => void
}) {
  useMapEvents({
    click: (e) => {
      if (!enabled) return
      onClick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

function AutoFitBounds({
  positions,
}: {
  positions: Array<{ lat: number; lon: number }>
}) {
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

// サイドバーで「セクション (=assignment)」を選択した時、その軌跡全体が
// 画面に収まるように 1 度だけ fitBounds する。
// 選択が変わる度に再フィット。同じ選択のまま数が増えても再フィットしない
// (常時ズームアウトされ続けるのを防ぐ)。
function FitToExtraTracks({
  tracks,
}: {
  tracks: Map<string, MobilityPosition[]>
}) {
  const map = useMap()
  const lastKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const keys = Array.from(tracks.keys()).sort().join(',')
    if (!keys) {
      lastKeyRef.current = null
      return
    }
    if (keys === lastKeyRef.current) return
    lastKeyRef.current = keys
    const points: [number, number][] = []
    for (const arr of tracks.values()) {
      for (const p of arr) points.push([p.lat, p.lon])
    }
    if (points.length === 0) return
    if (points.length === 1) {
      map.setView(points[0], 16, { animate: true })
    } else {
      map.fitBounds(points as LatLngBoundsExpression, {
        padding: [40, 40],
        maxZoom: 16,
        animate: true,
      })
    }
  }, [tracks, map])
  return null
}

// 追跡ターゲット (assignment) の位置に地図を追従させる。
//
// 挙動:
//   - **対象が切り替わった時のみ** setView (ズームを 16 まで確保)
//   - 同じ対象の位置更新は panTo で滑らかに (ズーム再計算しないので polyline
//     の再描画チラつきを抑える)
//   - 「地図の viewport 内に対象がまだ入っている」場合は panTo すらしない
//     (無駄な再描画を避ける)
//   - ユーザーが地図をドラッグしたら onUserPan で親に停止指示
function FollowTarget({
  target,
  onUserPan,
}: {
  target: { lat: number; lon: number; targetId: string } | null
  onUserPan: () => void
}) {
  const map = useMap()
  const currentTargetIdRef = useRef<string | null>(null)
  const suppressPanUntilRef = useRef<number>(0)

  useEffect(() => {
    if (!target) {
      currentTargetIdRef.current = null
      return
    }
    // ユーザー pan 検知を短時間抑止 (自前の setView/panTo が dragstart を
    // 発火させないはずだが念のため)
    suppressPanUntilRef.current = Date.now() + 500
    if (currentTargetIdRef.current !== target.targetId) {
      // 対象が切り替わった → ズームを保証しつつセンタリング
      map.setView([target.lat, target.lon], Math.max(map.getZoom(), 16), {
        animate: true,
      })
      currentTargetIdRef.current = target.targetId
      return
    }
    // 同じ対象の位置更新: 画面内なら何もしない、画面外に出そうなら panTo
    const bounds = map.getBounds()
    const targetLatLng = L.latLng(target.lat, target.lon)
    if (bounds.pad(-0.2).contains(targetLatLng)) {
      // 画面内側 80% に収まっている → 動かさない (再描画チラつき回避)
      return
    }
    map.panTo(targetLatLng, { animate: true, duration: 0.4 })
  }, [target, map])

  useEffect(() => {
    const handler = () => {
      if (Date.now() < suppressPanUntilRef.current) return
      onUserPan()
    }
    map.on('dragstart', handler)
    return () => {
      map.off('dragstart', handler)
    }
  }, [map, onUserPan])
  return null
}

interface FleetMapViewProps {
  organizationId: string
  /** マーカー押下で車両詳細へ飛ばす等の親フック */
  onSelectVehicle?: (vehicleId: string) => void
  /**
   * 稼働中割当の軌跡に加えて、追加で地図に描画したい assignment id 群。
   * 通常は「サイドバーで運行履歴のチェックボックスを ON にしたもの」。
   * 稼働中割当と重複しても構わない (Map で dedup される)。
   */
  extraTrackAssignmentIds?: string[]
  /** 現在パネルで展開中の運行現場のポイント (青ピンで地図に表示) */
  projectPoints?: MobilityProjectPoint[]
  /** ハイライトするポイント (編集中など)。id で指定 */
  highlightPointId?: string | null
  /** 地図クリックで新規ポイントを配置するモード */
  addPointMode?: boolean
  /** 新規ポイント配置時のクリック位置 */
  onMapClick?: (lat: number, lon: number) => void
  /** ポイントマーカー押下で編集開始等 */
  onSelectPoint?: (pointId: string) => void
  /**
   * 地図で追跡したい assignment id。null の間は追跡しない。
   * 指定した assignment の位置が更新される度に地図を再センタリング。
   * ユーザーが地図をドラッグすると追跡は一時停止 (別の id を渡すか、
   * 同じ id が再指定されたら再開)。
   */
  followAssignmentId?: string | null
}

export function FleetMapView({
  organizationId,
  onSelectVehicle,
  extraTrackAssignmentIds,
  projectPoints,
  highlightPointId,
  addPointMode,
  onMapClick,
  onSelectPoint,
  followAssignmentId,
}: FleetMapViewProps) {
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
  // サイドバーから明示的に「地図に出したい」と指示された assignment の軌跡
  const [extraTracks, setExtraTracks] = useState<
    Map<string, MobilityPosition[]>
  >(new Map())
  const [loading, setLoading] = useState(true)
  // 自動更新: 15 秒ごとに refreshAll を叩く (Realtime が届かない環境向けの保険 +
  // start/end assignment を確実に取り込むため)
  const [autoUpdate, setAutoUpdate] = useState(true)
  const AUTO_UPDATE_INTERVAL_MS = 15_000
  // 通信断表示の再描画用 tick (最終 ping からの経過を UI に反映)
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])
  // 60 秒以上 ping が来ていなければ「通信断」扱い
  const STALE_THRESHOLD_MS = 60_000

  // 追跡: ユーザーが地図をドラッグしたら一時停止するローカルフラグ。
  // followAssignmentId が親から変わったらリセット (=再度追跡開始)
  const [followSuspended, setFollowSuspended] = useState(false)
  useEffect(() => {
    setFollowSuspended(false)
  }, [followAssignmentId])
  // 追跡対象の position (targetId が変わったら「別対象」、それ以外は位置更新のみ)
  const followTarget = useMemo(() => {
    if (!followAssignmentId || followSuspended) return null
    const p = latestPositions.get(followAssignmentId)
    if (!p) return null
    return { lat: p.lat, lon: p.lon, targetId: followAssignmentId }
  }, [followAssignmentId, followSuspended, latestPositions])

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

  // 自動更新の定期ポーリング (Realtime のフォールバック兼 assignment 数の反映)
  useEffect(() => {
    if (!autoUpdate) return
    const id = setInterval(() => {
      void refreshAll()
    }, AUTO_UPDATE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [autoUpdate, refreshAll])

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
          // store の共有 map も更新 (サイドバーの通信断バッジ計算で使う)
          useMobilityStore.getState().applyLatestPosition(row)
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

  // サイドバーの履歴チェックで指定された assignment の位置ログを都度取得。
  // 差分だけ fetch すれば十分だが、件数は多くて数十件なので毎回まとめて取り直す。
  useEffect(() => {
    const ids = extraTrackAssignmentIds ?? []
    if (ids.length === 0) {
      setExtraTracks(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const map = await fetchPositionsForAssignments(ids, 1000)
      if (!cancelled) setExtraTracks(map)
    })()
    return () => {
      cancelled = true
    }
  }, [extraTrackAssignmentIds, fetchPositionsForAssignments])

  // vehicle_assignments の UPDATE を購読して、ドライバーが行き先を変えたら
  // 管理画面に即反映させる。start/end (INSERT / ended_at) はこの購読では
  // 拾わないので、その辺の変化は fetchActiveAssignments に依存 (再取得ボタン)。
  useEffect(() => {
    const channel = supabase
      .channel(`vehicle-assignments-fleet-${organizationId}`)
      // UPDATE (行き先変更 / 降車=ended_at セット) を購読
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'vehicle_assignments' },
        () => {
          // 差分適用は destination_point の enrich が必要で面倒なので、
          // 割当一覧を丸ごと再取得 (件数はせいぜい 数十件)
          void useMobilityStore.getState().fetchActiveAssignments(organizationId)
        },
      )
      // INSERT (新規乗車) も購読 → 新しい稼働マーカーを即出す
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vehicle_assignments' },
        () => {
          void useMobilityStore.getState().fetchActiveAssignments(organizationId)
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
      destination: {
        id: string
        name: string
        lat: number
        lon: number
      } | null
    }[] = []
    for (const [assignmentId, pos] of latestPositions) {
      const assignment = Array.from(activeAssignments.values()).find(
        (a) => a.id === assignmentId,
      )
      if (!assignment) continue
      const vehicle = vehicles.find((v) => v.id === assignment.vehicle_id)
      const dp = assignment.destination_point
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
        destination: dp
          ? { id: dp.id, name: dp.name, lat: dp.lat, lon: dp.lon }
          : null,
      })
    }
    return rows
  }, [latestPositions, activeAssignments, vehicles])

  const positionsForBounds = useMemo(() => {
    const rows: { lat: number; lon: number }[] = []
    for (const p of latestPositions.values()) rows.push({ lat: p.lat, lon: p.lon })
    // 目的地も画面に収める
    for (const m of markers) {
      if (m.destination) rows.push({ lat: m.destination.lat, lon: m.destination.lon })
    }
    // 履歴選択の軌跡端点も収める (全点だと重いので開始/最終のみ)
    for (const arr of extraTracks.values()) {
      if (arr.length === 0) continue
      const first = arr[0]
      const last = arr[arr.length - 1]
      rows.push({ lat: first.lat, lon: first.lon })
      if (last.id !== first.id) rows.push({ lat: last.lat, lon: last.lon })
    }
    // 展開中の運行現場のポイントも
    for (const p of projectPoints ?? []) rows.push({ lat: p.lat, lon: p.lon })
    return rows
  }, [latestPositions, markers, extraTracks, projectPoints])

  return (
    <div className="relative h-full w-full">
      {/* 右上オーバーレイ: 稼働数 + 自動更新トグル + 再取得ボタン */}
      <div className="absolute top-3 right-3 z-[1000] flex items-center gap-2 bg-white/95 rounded-lg border shadow px-3 py-1.5 text-xs">
        <span className="text-slate-600">
          稼働中 {markers.length} / {activeAssignments.size}
        </span>
        {/* 追跡状態 */}
        {followAssignmentId && (
          <span
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${
              followSuspended
                ? 'bg-slate-100 text-slate-600 border-slate-300'
                : 'bg-indigo-100 text-indigo-700 border-indigo-300'
            }`}
            title={
              followSuspended
                ? '追跡は手動で停止中 (もう一度対象を選び直すと再開)'
                : '対象を追跡中 (地図をドラッグすると解除)'
            }
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                followSuspended ? 'bg-slate-400' : 'bg-indigo-500 animate-pulse'
              }`}
            />
            {followSuspended ? '追跡停止中' : '追跡中'}
          </span>
        )}
        {/* 自動更新トグル */}
        <button
          type="button"
          onClick={() => setAutoUpdate((v) => !v)}
          role="switch"
          aria-checked={autoUpdate}
          title={
            autoUpdate
              ? `${AUTO_UPDATE_INTERVAL_MS / 1000} 秒ごとに自動更新中 (クリックで停止)`
              : '自動更新は停止中 (クリックで開始)'
          }
          className={`flex items-center gap-1 px-2 py-0.5 rounded border transition ${
            autoUpdate
              ? 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <span
            className={`inline-block h-2.5 w-4 rounded-full relative ${
              autoUpdate ? 'bg-emerald-200' : 'bg-slate-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-1.5 w-1.5 rounded-full bg-white transition-all ${
                autoUpdate ? 'left-2' : 'left-0.5'
              }`}
            />
          </span>
          自動更新
        </button>
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

      {addPointMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-indigo-600 text-white text-xs rounded-full px-3 py-1 shadow flex items-center gap-2">
          <span>地図をクリックしてポイントを配置</span>
        </div>
      )}
      <MapContainer
        center={[35.681236, 139.767125]}
        zoom={5}
        className="h-full w-full"
        style={addPointMode ? { cursor: 'crosshair' } : undefined}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <AutoFitBounds positions={positionsForBounds} />
        <FitToExtraTracks tracks={extraTracks} />
        <FollowTarget
          target={followTarget}
          onUserPan={() => setFollowSuspended(true)}
        />
        {onMapClick && (
          <MapClickHandler enabled={!!addPointMode} onClick={onMapClick} />
        )}
        {/* 運行現場ポイント (展開中の現場のもの) */}
        {(projectPoints ?? []).map((p) => (
          <Marker
            key={`project-point-${p.id}`}
            position={[p.lat, p.lon]}
            icon={projectPointIcon(highlightPointId === p.id)}
            eventHandlers={
              onSelectPoint ? { click: () => onSelectPoint(p.id) } : undefined
            }
          >
            <Tooltip direction="top" offset={[0, -30]} permanent>
              <span className="text-xs font-medium">
                {p.name}
                {p.kind && <span className="text-slate-500 ml-1">({p.kind})</span>}
              </span>
            </Tooltip>
          </Marker>
        ))}
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
        {/* サイドバー履歴チェックの追加軌跡 (稼働中と同じ色で描画。
            稼働中割当と重複したら trackPositions 側が上書きするので二重描画のみ) */}
        {Array.from(extraTracks.entries()).map(([assignmentId, points]) => {
          if (points.length < 2) return null
          if (trackPositions.has(assignmentId)) return null // 稼働中軌跡と重複
          const line = points.map((p) => [p.lat, p.lon] as [number, number])
          return (
            <Polyline
              key={`extra-track-${assignmentId}`}
              positions={line}
              pathOptions={{
                color: colorForAssignment(assignmentId),
                weight: 3,
                opacity: 0.85,
                dashArray: '4 6',
              }}
            />
          )
        })}
        {/* 各車両の「現在地→行き先」オレンジ破線 (行き先セット中のみ) */}
        {markers.map((m) => {
          if (!m.destination) return null
          return (
            <Polyline
              key={`dest-line-${m.assignmentId}`}
              positions={[
                [m.lat, m.lon],
                [m.destination.lat, m.destination.lon],
              ]}
              pathOptions={{
                color: '#f59e0b',
                weight: 3,
                opacity: 0.9,
                dashArray: '6 8',
              }}
            />
          )
        })}
        {/* 行き先ピン (複数車両が同じピンを見ていても重ねて表示) */}
        {markers.map((m) => {
          if (!m.destination) return null
          return (
            <Marker
              key={`dest-marker-${m.assignmentId}`}
              position={[m.destination.lat, m.destination.lon]}
              icon={buildDestinationIcon(m.destination.name)}
              zIndexOffset={1000}
            />
          )
        })}
        {markers.map((m) => {
          const ageMs = nowTick - new Date(m.recordedAt).getTime()
          const isStale = ageMs > STALE_THRESHOLD_MS
          const parts: string[] = [m.vehicleName]
          if (m.speed_kmh != null && m.speed_kmh >= 0 && !isStale) {
            parts.push(`${Math.round(m.speed_kmh)}km/h`)
          }
          if (isStale) {
            parts.push(`⚠ 通信断 ${formatAgeShort(ageMs)}`)
          }
          if (m.destination) {
            const dist = haversineMeters(
              { lat: m.lat, lon: m.lon },
              { lat: m.destination.lat, lon: m.destination.lon },
            )
            const deg = bearingDeg(
              { lat: m.lat, lon: m.lon },
              { lat: m.destination.lat, lon: m.destination.lon },
            )
            parts.push(
              `→${m.destination.name} (${bearingLabel(deg)} ${formatDistance(dist)})`,
            )
          }
          const label = parts.join(' ')
          return (
            <VehicleMarker
              key={m.assignmentId}
              position={[m.lat, m.lon]}
              heading={m.heading_deg}
              color={isStale ? '#94a3b8' : COLOR_ACTIVE}
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
