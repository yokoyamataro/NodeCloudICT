import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  ArrowLeft,
  ArrowUp,
  Loader2,
  Crosshair,
  Circle as CircleIcon,
  Radio,
  Settings,
  List,
  Save,
  Tag,
  Trash2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useUnderdrainStore, type PipeRow, PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import { useStakingStore, type StakingRecord } from '@/stores/stakingStore'
import { CoordinateConverter } from '@/lib/coordinates'
import type { Project } from '@/types/database'

type TargetKind = 'coordinate' | 'pipe_vertex'

interface StakingTarget {
  id: string
  kind: TargetKind
  refId: string
  vertexIndex: number | null
  name: string
  x: number
  y: number
  z: number | null
  /** lat/lng（地図表示用） */
  lat: number
  lng: number
}

// Haversine 距離（m）
function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6378137
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  return R * c
}

// 真北基準の方位角（deg, 0–360）
function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  const brng = toDeg(Math.atan2(y, x))
  return (brng + 360) % 360
}

function accuracyColor(acc: number | null): string {
  if (acc == null) return '#94a3b8'
  if (acc <= 0.05) return '#10b981' // green <= 5cm
  if (acc <= 0.2) return '#f59e0b' // amber <= 20cm
  if (acc <= 1) return '#f97316' // orange <= 1m
  return '#ef4444' // red
}

function FitOnce({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  const doneRef = useRef(false)
  useEffect(() => {
    if (doneRef.current) return
    if (!bounds) return
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 })
    doneRef.current = true
  }, [map, bounds])
  return null
}

function FollowCurrent({
  position,
  enabled,
}: {
  position: [number, number] | null
  enabled: boolean
}) {
  const map = useMap()
  useEffect(() => {
    if (!enabled || !position) return
    map.setView(position, Math.max(map.getZoom(), 18), { animate: true })
  }, [map, position, enabled])
  return null
}

export function MobileStakingPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const { setZone, fetchCoordinates, coordinates } = useCoordinateStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { records, fetchRecords, addRecord, deleteRecord, saving } = useStakingStore()

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 現在位置（geolocation）
  const [currentPos, setCurrentPos] = useState<[number, number] | null>(null)
  const [currentAcc, setCurrentAcc] = useState<number | null>(null)
  const [currentAlt, setCurrentAlt] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)

  // 設定・UI
  const [avgSeconds, setAvgSeconds] = useState(3)
  const [showSettings, setShowSettings] = useState(false)
  const [showTargetList, setShowTargetList] = useState(false)
  const [showRecordList, setShowRecordList] = useState(false)
  const [targetFilter, setTargetFilter] = useState<'all' | 'coordinate' | 'pipe_vertex'>('all')
  const [showLabels, setShowLabels] = useState(false)

  // 測設成功とみなす許容半径（m）
  const STAKE_TOLERANCE_M = 0.20

  // 選択中ターゲット
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  // 選択中の配線（タップでハイライト＋情報表示）
  const [selectedPipeId, setSelectedPipeId] = useState<string | null>(null)

  // 記録状態
  const [recording, setRecording] = useState(false)
  const [recordedCount, setRecordedCount] = useState(0)
  const recSamplesRef = useRef<Array<{ lat: number; lng: number; alt: number | null; acc: number | null }>>([])
  const recTimerRef = useRef<number | null>(null)
  const recCleanupRef = useRef<(() => void) | null>(null)

  // データ読込
  useEffect(() => {
    if (!farmId) {
      setError('URL に farmId が指定されていません')
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const { data: farmData, error: farmErr } = await supabase
          .from('farms')
          .select('*')
          .eq('id', farmId)
          .single()
        if (farmErr) throw farmErr
        if (cancelled) return
        const typedFarm = farmData as Farm
        setFarm(typedFarm)
        setCurrentFarm(typedFarm)

        if (typedFarm.project_id) {
          const { data: projData } = await supabase
            .from('projects')
            .select('*')
            .eq('id', typedFarm.project_id)
            .single()
          if (!cancelled && projData) {
            const typedProj = projData as Project
            setProject(typedProj)
            useProjectListStore.setState({ currentProject: typedProj })
            setZone(typedProj.coordinate_zone)
          }
        }

        await Promise.all([
          fetchCoordinates(typedFarm.id),
          fetchPipes(typedFarm.id),
          fetchRecords(typedFarm.id),
        ])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込み失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [farmId, setCurrentFarm, setZone, fetchCoordinates, fetchPipes, fetchRecords])

  // 現在位置の監視
  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setCurrentPos([pos.coords.latitude, pos.coords.longitude])
        setCurrentAcc(pos.coords.accuracy)
        setCurrentAlt(pos.coords.altitude)
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  const zone = project?.coordinate_zone ?? 13
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // ターゲット一覧（座標管理 + 暗渠頂点）
  const targets = useMemo<StakingTarget[]>(() => {
    const out: StakingTarget[] = []
    for (const c of coordinates as CoordinateRow[]) {
      if (c.lat == null || c.lng == null) continue
      out.push({
        id: `c-${c.id}`,
        kind: 'coordinate',
        refId: c.id,
        vertexIndex: null,
        name: c.pointNumber,
        x: c.x,
        y: c.y,
        z: c.z,
        lat: c.lat,
        lng: c.lng,
      })
    }
    for (const pipe of pipes as PipeRow[]) {
      for (let i = 0; i < pipe.vertices.length; i++) {
        const v = pipe.vertices[i]
        try {
          const { lat, lng } = converter.toLatLng(v.x, v.y)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          const total = pipe.vertices.length
          let suffix: string
          if (i === 0) suffix = 'C'
          else if (i === total - 1) suffix = 'A'
          else suffix = `B${total - 1 - i}`
          out.push({
            id: `v-${pipe.id}-${i}`,
            kind: 'pipe_vertex',
            refId: pipe.id,
            vertexIndex: i,
            name: `${pipe.number}${suffix}`,
            x: v.x,
            y: v.y,
            z: v.z,
            lat,
            lng,
          })
        } catch {
          // skip
        }
      }
    }
    return out
  }, [coordinates, pipes, converter])

  const filteredTargets = useMemo(() => {
    if (targetFilter === 'all') return targets
    return targets.filter((t) => t.kind === targetFilter)
  }, [targets, targetFilter])

  const selectedTarget = useMemo(
    () => targets.find((t) => t.id === selectedTargetId) ?? null,
    [targets, selectedTargetId],
  )

  const distanceToTarget = useMemo(() => {
    if (!currentPos || !selectedTarget) return null
    return distanceMeters(
      { lat: currentPos[0], lng: currentPos[1] },
      { lat: selectedTarget.lat, lng: selectedTarget.lng },
    )
  }, [currentPos, selectedTarget])

  const bearingToTarget = useMemo(() => {
    if (!currentPos || !selectedTarget) return null
    return bearingDeg(
      { lat: currentPos[0], lng: currentPos[1] },
      { lat: selectedTarget.lat, lng: selectedTarget.lng },
    )
  }, [currentPos, selectedTarget])

  // 現在位置を平面直角座標 (X=北, Y=東) に変換
  const currentXY = useMemo(() => {
    if (!currentPos) return null
    try {
      return converter.toXY(currentPos[0], currentPos[1])
    } catch {
      return null
    }
  }, [currentPos, converter])

  const allBounds = useMemo(() => {
    const all: [number, number][] = []
    for (const t of targets) all.push([t.lat, t.lng])
    if (currentPos) all.push(currentPos)
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [targets, currentPos])

  // 配線（吸水管・集水管）の線形を緯度経度ポリラインに変換
  const pipePolylines = useMemo(() => {
    const out: Array<{
      id: string
      pipeType: 'branch' | 'collector'
      number: string
      positions: [number, number][]
    }> = []
    for (const pipe of pipes as PipeRow[]) {
      if (pipe.vertices.length < 2) continue
      const positions: [number, number][] = []
      for (const v of pipe.vertices) {
        try {
          const { lat, lng } = converter.toLatLng(v.x, v.y)
          if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push([lat, lng])
        } catch {
          // skip
        }
      }
      if (positions.length < 2) continue
      out.push({
        id: pipe.id,
        // branch=吸水管、それ以外（main/collector/outlet等）はまとめて collector 扱い
        pipeType: pipe.pipeType === 'branch' ? 'branch' : 'collector',
        number: pipe.number,
        positions,
      })
    }
    return out
  }, [pipes, converter])

  // 既に測設済み（記録の measuredXY とターゲット XY が許容範囲内で一致）のターゲット ID 集合
  const stakedTargetIds = useMemo(() => {
    const set = new Set<string>()
    for (const t of targets) {
      const hit = records.some((r) => {
        if (r.targetType === 'free') return false
        if (r.targetType !== t.kind) return false
        if (r.targetRefId !== t.refId) return false
        if (t.kind === 'pipe_vertex' && r.targetVertexIndex !== t.vertexIndex) return false
        if (r.targetX == null || r.targetY == null) return false
        const dx = r.measuredX - r.targetX
        const dy = r.measuredY - r.targetY
        return Math.hypot(dx, dy) <= STAKE_TOLERANCE_M
      })
      if (hit) set.add(t.id)
    }
    return set
  }, [targets, records])

  // 記録開始
  const startRecording = () => {
    if (recording) return
    if (!('geolocation' in navigator)) {
      alert('Geolocation が利用できません')
      return
    }
    if (!farmId) return
    recSamplesRef.current = []
    setRecordedCount(0)
    setRecording(true)

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        recSamplesRef.current.push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt: pos.coords.altitude,
          acc: pos.coords.accuracy,
        })
        setRecordedCount(recSamplesRef.current.length)
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )

    recCleanupRef.current = () => {
      try {
        navigator.geolocation.clearWatch(watchId)
      } catch {
        // ignore
      }
    }
    recTimerRef.current = window.setTimeout(() => {
      finishRecording()
    }, avgSeconds * 1000)
  }

  // 記録終了・保存
  const finishRecording = async () => {
    if (recTimerRef.current != null) {
      window.clearTimeout(recTimerRef.current)
      recTimerRef.current = null
    }
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    const samples = recSamplesRef.current
    setRecording(false)
    if (samples.length === 0) {
      alert('位置情報が取得できませんでした')
      return
    }
    if (!farmId) return

    // 平均値を算出
    let sumLat = 0
    let sumLng = 0
    let sumAlt = 0
    let altCount = 0
    let maxAcc = 0
    for (const s of samples) {
      sumLat += s.lat
      sumLng += s.lng
      if (s.alt != null && Number.isFinite(s.alt)) {
        sumAlt += s.alt
        altCount++
      }
      if (s.acc != null && Number.isFinite(s.acc)) {
        maxAcc = Math.max(maxAcc, s.acc)
      }
    }
    const avgLat = sumLat / samples.length
    const avgLng = sumLng / samples.length
    const avgAlt = altCount > 0 ? sumAlt / altCount : null

    const { x, y } = converter.toXY(avgLat, avgLng)

    // ターゲットとの距離を測って許容内なら「測設」、そうでなければ「新点」として保存
    const dX = selectedTarget?.x != null ? x - selectedTarget.x : null
    const dY = selectedTarget?.y != null ? y - selectedTarget.y : null
    const dist = dX != null && dY != null ? Math.hypot(dX, dY) : null
    const isStake = !!(selectedTarget && dist !== null && dist <= STAKE_TOLERANCE_M)

    // 新点（free）の場合は点名を入力させる。キャンセルされたら保存しない。
    let freePointName: string | null = null
    if (!isStake) {
      const freeCount = records.filter((r) => r.targetType === 'free').length
      const defaultName = `新点-${freeCount + 1}`
      const promptMsg =
        selectedTarget && dist !== null
          ? `誤差が大きいため新点として記録します（${dist.toFixed(3)} m）。\n点名を入力してください:`
          : '新点として記録します。点名を入力してください:'
      const input = window.prompt(promptMsg, defaultName)
      if (input === null) {
        // キャンセル → 保存中止
        return
      }
      freePointName = input.trim() || defaultName
    }

    const saved = await addRecord({
      farmId,
      targetType: isStake ? selectedTarget!.kind : 'free',
      targetRefId: isStake ? selectedTarget!.refId : null,
      targetVertexIndex: isStake ? selectedTarget!.vertexIndex : null,
      targetName: isStake ? selectedTarget!.name : freePointName,
      targetX: isStake ? selectedTarget!.x : null,
      targetY: isStake ? selectedTarget!.y : null,
      targetZ: isStake ? selectedTarget!.z : null,
      measuredX: x,
      measuredY: y,
      measuredZ: avgAlt,
      accuracy: maxAcc || null,
      sampleCount: samples.length,
      durationSeconds: avgSeconds,
      notes: null,
    })
    if (saved) {
      let msg: string
      if (isStake && selectedTarget) {
        msg =
          `${selectedTarget.name} を測設しました\n` +
          `誤差 ${dist!.toFixed(3)} m / 精度 ${maxAcc.toFixed(3)} m / ${samples.length} サンプル`
        // 次のターゲットへ自動遷移（filteredTargets の次の要素）
        const idx = filteredTargets.findIndex((t) => t.id === selectedTarget.id)
        const next = idx >= 0 ? filteredTargets[idx + 1] : null
        setSelectedTargetId(next?.id ?? null)
      } else if (selectedTarget && dist !== null) {
        msg =
          `${freePointName} を新点として記録しました（誤差 ${dist.toFixed(3)} m）\n` +
          `精度 ${maxAcc.toFixed(3)} m / ${samples.length} サンプル`
      } else {
        msg =
          `${freePointName} を新点として記録しました\n` +
          `精度 ${maxAcc.toFixed(3)} m / ${samples.length} サンプル`
      }
      alert(msg)
    }
  }

  const cancelRecording = () => {
    if (recTimerRef.current != null) {
      window.clearTimeout(recTimerRef.current)
      recTimerRef.current = null
    }
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    recSamplesRef.current = []
    setRecordedCount(0)
    setRecording(false)
  }

  // アンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      if (recTimerRef.current != null) window.clearTimeout(recTimerRef.current)
      if (recCleanupRef.current) recCleanupRef.current()
    }
  }, [])

  const mapCenter: [number, number] = currentPos
    ? currentPos
    : allBounds
      ? [
          (allBounds.getNorth() + allBounds.getSouth()) / 2,
          (allBounds.getEast() + allBounds.getWest()) / 2,
        ]
      : [43.06, 141.35]

  if (loading) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mobile-min-screen flex flex-col bg-slate-100">
        <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center">
          <button onClick={() => navigate('/mobile')} className="flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            戻る
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="p-4 bg-white rounded shadow text-red-600 text-sm">{error}</div>
        </div>
      </div>
    )
  }

  const title = project ? `${project.name} / ${farm?.name}` : (farm?.name ?? '起工測量')

  return (
    <div className="mobile-screen flex flex-col">
      {/* ヘッダー */}
      <div className="px-2 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate('/mobile')}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700"
          title="戻る"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-medium truncate flex-1">{title}</span>
        <button
          onClick={() => setFollow((v) => !v)}
          className={`p-1.5 rounded ${
            follow ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="現在地に追従"
        >
          <Crosshair className="h-4 w-4" />
        </button>
        <button
          onClick={() => setShowLabels((v) => !v)}
          className={`p-1.5 rounded ${
            showLabels ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="点名表示"
        >
          <Tag className="h-4 w-4" />
        </button>
        <button
          onClick={() => setShowRecordList((v) => !v)}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600 relative"
          title="記録一覧"
        >
          <List className="h-4 w-4" />
          {records.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
              {records.length > 9 ? '9+' : records.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600"
          title="設定"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* 精度インジケータ */}
      <div
        className="px-3 py-1 text-xs flex items-center gap-2 bg-slate-100 border-b"
        style={{ color: accuracyColor(currentAcc) }}
      >
        <Radio className="h-3.5 w-3.5" />
        <span className="font-mono">
          精度: {currentAcc != null ? `${currentAcc.toFixed(3)} m` : '未取得'}
        </span>
        {currentAlt != null && (
          <span className="ml-auto text-slate-600 font-mono">標高 {currentAlt.toFixed(3)} m</span>
        )}
      </div>

      {/* 地図 */}
      <div className="flex-1 relative">
        <MapContainer center={mapCenter} zoom={17} maxZoom={22} className="h-full w-full">
          <TileLayer
            attribution='&copy; 国土地理院'
            url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
            maxZoom={22}
            maxNativeZoom={18}
          />
          <FitOnce bounds={currentPos ? null : allBounds} />
          <FollowCurrent position={currentPos} enabled={follow} />

          {/* 配線ライン（吸水=青・集水=緑、選択中はオレンジ）
              タップ判定を確実にするため、透明な太い「ヒットレイヤ」を上に重ねる */}
          {pipePolylines.flatMap((p) => {
            const isSelected = p.id === selectedPipeId
            const baseColor = p.pipeType === 'branch' ? '#2563eb' : '#10b981'
            return [
              // 表示用ライン（クリック非対応）
              <Polyline
                key={`pipe-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: isSelected ? '#f97316' : baseColor,
                  weight: isSelected ? 5 : p.pipeType === 'branch' ? 2 : 3,
                  opacity: isSelected ? 1 : 0.85,
                  interactive: false,
                }}
              />,
              // タップ判定用の太い透明ライン（指タップでも確実に拾える）
              <Polyline
                key={`pipe-hit-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: '#000',
                  weight: 20,
                  opacity: 0,
                }}
                eventHandlers={{
                  click: () => setSelectedPipeId(p.id),
                }}
              />,
            ]
          })}

          {/* ターゲット */}
          {filteredTargets.map((t) => {
            const isSelected = t.id === selectedTargetId
            const isStaked = stakedTargetIds.has(t.id)
            // 色: 測設済 = 灰、座標管理 = 青、暗渠頂点 = 緑
            const fillColor = isStaked
              ? '#94a3b8'
              : t.kind === 'coordinate'
                ? '#3b82f6'
                : '#22c55e'
            const size = isSelected ? 16 : 10
            return (
              <Marker
                key={t.id}
                position={[t.lat, t.lng]}
                icon={L.divIcon({
                  className: 'staking-target',
                  html: `<div style="
                    width:${size}px;
                    height:${size}px;
                    background:${fillColor};
                    border:2px solid white;
                    border-radius:50%;
                    box-shadow:0 1px 3px rgba(0,0,0,0.4);
                    ${isStaked ? 'opacity:0.7;' : ''}
                  "></div>`,
                  iconSize: [size, size],
                  iconAnchor: [size / 2, size / 2],
                })}
                eventHandlers={{
                  click: () => setSelectedTargetId(t.id),
                }}
              >
                <Tooltip
                  key={`tip-${showLabels ? 'on' : 'off'}`}
                  direction="top"
                  offset={[0, -6]}
                  permanent={showLabels}
                  className={isStaked ? 'staking-label-staked' : undefined}
                >
                  {isStaked ? `✓ ${t.name}` : t.name}
                </Tooltip>
              </Marker>
            )
          })}

          {/* 現在位置 */}
          {currentPos && (
            <>
              {currentAcc != null && (
                <CircleMarker
                  center={currentPos}
                  radius={Math.min(60, Math.max(6, currentAcc * 10))}
                  pathOptions={{
                    color: accuracyColor(currentAcc),
                    fillColor: accuracyColor(currentAcc),
                    fillOpacity: 0.15,
                    weight: 1,
                  }}
                />
              )}
              <CircleMarker
                center={currentPos}
                radius={6}
                pathOptions={{
                  color: accuracyColor(currentAcc),
                  fillColor: '#2563eb',
                  fillOpacity: 1,
                  weight: 2,
                }}
              />
            </>
          )}
        </MapContainer>

        {/* 選択中の配線情報 */}
        {selectedPipeId && (() => {
          const pipe = pipes.find((p) => p.id === selectedPipeId)
          if (!pipe) return null
          const typeLabel = pipe.pipeType ? PIPE_TYPE_NAMES[pipe.pipeType] : '-'
          const length =
            pipe.measuredLength != null
              ? `${pipe.measuredLength.toFixed(2)} m（実測）`
              : pipe.designLength != null
                ? `${pipe.designLength.toFixed(2)} m（設計）`
                : '-'
          return (
            <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow-lg p-2 text-xs space-y-0.5 max-w-[60%]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-800 truncate">{pipe.number}</span>
                <button
                  onClick={() => setSelectedPipeId(null)}
                  className="text-slate-400 hover:text-slate-700 px-1"
                  title="閉じる"
                >
                  ×
                </button>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">管種:</span>
                <span className="font-mono text-slate-800">{typeLabel}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">管径:</span>
                <span className="font-mono text-slate-800">
                  {pipe.diameter != null ? `${pipe.diameter} mm` : '-'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">延長:</span>
                <span className="font-mono text-slate-800">{length}</span>
              </div>
            </div>
          )
        })()}

        {/* 設定パネル */}
        {showSettings && (
          <div className="absolute top-2 right-2 z-[1000] bg-white border rounded-lg shadow-lg p-3 w-56 text-sm">
            <div className="font-semibold mb-2">設定</div>
            <label className="flex flex-col gap-1 mb-2">
              <span className="text-xs text-slate-600">平均秒数</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={avgSeconds}
                onChange={(e) => setAvgSeconds(parseInt(e.target.value, 10))}
                disabled={recording}
              />
              <span className="font-mono text-center">{avgSeconds} 秒</span>
            </label>
            <div className="text-xs text-slate-500 mt-2">
              Mock Location 経由で RTK-GNSS の補正座標を取得できます。
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="mt-2 w-full px-2 py-1 text-xs border rounded hover:bg-slate-50"
            >
              閉じる
            </button>
          </div>
        )}

        {/* ターゲットリスト（下部スライドアップ） */}
        {showTargetList && (
          <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[50%] flex flex-col">
            <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
              <span className="font-semibold">ターゲット</span>
              <div className="ml-2 flex gap-1 text-xs">
                <button
                  onClick={() => setTargetFilter('all')}
                  className={`px-2 py-0.5 rounded border ${
                    targetFilter === 'all' ? 'bg-slate-800 text-white border-slate-800' : ''
                  }`}
                >
                  全て
                </button>
                <button
                  onClick={() => setTargetFilter('coordinate')}
                  className={`px-2 py-0.5 rounded border ${
                    targetFilter === 'coordinate' ? 'bg-blue-600 text-white border-blue-600' : ''
                  }`}
                >
                  座標
                </button>
                <button
                  onClick={() => setTargetFilter('pipe_vertex')}
                  className={`px-2 py-0.5 rounded border ${
                    targetFilter === 'pipe_vertex' ? 'bg-emerald-600 text-white border-emerald-600' : ''
                  }`}
                >
                  暗渠頂点
                </button>
              </div>
              <button
                onClick={() => setShowTargetList(false)}
                className="ml-auto text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {filteredTargets.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">該当なし</div>
              ) : (
                <ul className="divide-y text-sm">
                  {filteredTargets.map((t) => {
                    const dist = currentPos
                      ? distanceMeters({ lat: currentPos[0], lng: currentPos[1] }, { lat: t.lat, lng: t.lng })
                      : null
                    const isSelected = t.id === selectedTargetId
                    return (
                      <li
                        key={t.id}
                        onClick={() => {
                          setSelectedTargetId(t.id)
                          setShowTargetList(false)
                        }}
                        className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${
                          isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor: t.kind === 'coordinate' ? '#3b82f6' : '#22c55e',
                          }}
                        />
                        <span className="flex-1 font-medium">{t.name}</span>
                        <span className="text-xs text-slate-500">
                          {t.kind === 'coordinate'
                            ? '座標'
                            : '頂点'}
                        </span>
                        {dist != null && (
                          <span className="text-xs font-mono text-slate-600 w-16 text-right">
                            {dist < 1 ? `${(dist * 100).toFixed(0)}cm` : `${dist.toFixed(1)}m`}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* 記録リスト */}
        {showRecordList && (
          <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[60%] flex flex-col">
            <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
              <span className="font-semibold">実測記録</span>
              <span className="text-xs text-slate-500">{records.length} 件</span>
              <button
                onClick={() => setShowRecordList(false)}
                className="ml-auto text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {records.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">記録なし</div>
              ) : (
                <RecordList records={records} onDelete={deleteRecord} saving={saving} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 下部パネル */}
      <div className="border-t bg-white px-3 py-2 text-sm">
        {selectedTarget ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowTargetList(true)}
              className="flex-1 min-w-0 text-left"
              title="ターゲット切替"
            >
              <div className="text-xs text-slate-500">ターゲット</div>
              <div className="font-bold truncate">
                {selectedTarget.name}
                <span className="ml-2 text-xs text-slate-500 font-normal">
                  {selectedTarget.kind === 'coordinate' ? '座標' : '暗渠頂点'}
                </span>
              </div>
            </button>
            {distanceToTarget != null && bearingToTarget != null && (
              <div className="flex items-center gap-2">
                {/* 矢印（北を 0° として時計回りに回転） */}
                <ArrowUp
                  className="h-7 w-7 text-blue-600"
                  style={{
                    transform: `rotate(${bearingToTarget}deg)`,
                    transition: 'transform 120ms linear',
                  }}
                />
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 leading-none">
                    {bearingToTarget.toFixed(0)}°
                  </div>
                  <div className="font-mono font-bold text-lg leading-tight">
                    {distanceToTarget < 1
                      ? `${(distanceToTarget * 100).toFixed(0)} cm`
                      : `${distanceToTarget.toFixed(2)} m`}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowTargetList(true)}
            className="w-full py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            ターゲットを選択
          </button>
        )}

        {/* 現在地 XYZ */}
        <div className="mt-1 text-[11px] font-mono text-slate-600 flex items-center gap-3 border-t pt-1">
          <span className="text-slate-500">現在地</span>
          {currentXY ? (
            <>
              <span>
                X: <span className="text-slate-800">{currentXY.x.toFixed(3)}</span>
              </span>
              <span>
                Y: <span className="text-slate-800">{currentXY.y.toFixed(3)}</span>
              </span>
              <span>
                Z:{' '}
                <span className="text-slate-800">
                  {currentAlt != null ? currentAlt.toFixed(3) : '-'}
                </span>
              </span>
            </>
          ) : (
            <span className="text-slate-400">取得中...</span>
          )}
        </div>

        {/* 記録ボタン */}
        <div className="mt-2 flex gap-2">
          {!recording ? (
            <button
              onClick={startRecording}
              disabled={saving || !currentPos}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed font-bold"
            >
              <CircleIcon className="h-5 w-5" />
              記録 ({avgSeconds} 秒平均)
            </button>
          ) : (
            <>
              <div className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 text-white rounded-lg font-bold">
                <Loader2 className="h-5 w-5 animate-spin" />
                記録中… {recordedCount} サンプル
              </div>
              <button
                onClick={cancelRecording}
                className="px-3 py-3 border rounded-lg hover:bg-slate-50"
              >
                中止
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function RecordList({
  records,
  onDelete,
  saving,
}: {
  records: StakingRecord[]
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  return (
    <ul className="divide-y text-sm">
      {records.map((r) => {
        const diff =
          r.targetX != null && r.targetY != null
            ? Math.hypot(r.measuredX - r.targetX, r.measuredY - r.targetY)
            : null
        const isOpen = expanded.has(r.id)
        return (
          <li key={r.id} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s)
                    if (n.has(r.id)) n.delete(r.id)
                    else n.add(r.id)
                    return n
                  })
                }
                className="p-0.5"
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {r.targetName ?? '(フリー記録)'}
                </div>
                <div className="text-[11px] text-slate-500">
                  {new Date(r.recordedAt).toLocaleString('ja-JP')}
                  {r.accuracy != null && ` · 精度 ${r.accuracy.toFixed(3)}m`}
                  {r.sampleCount != null && ` · ${r.sampleCount}samples`}
                </div>
              </div>
              {diff != null && (
                <span className="text-xs font-mono text-slate-700 w-16 text-right">
                  Δ{diff < 1 ? `${(diff * 100).toFixed(0)}cm` : `${diff.toFixed(2)}m`}
                </span>
              )}
              <button
                onClick={() => {
                  if (confirm('この記録を削除しますか？')) onDelete(r.id)
                }}
                disabled={saving}
                className="p-1 text-slate-400 hover:text-red-500 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {isOpen && (
              <div className="mt-1 ml-5 text-[11px] text-slate-600 font-mono space-y-0.5">
                {r.targetX != null && (
                  <div>
                    目標: X={r.targetX.toFixed(3)}, Y={r.targetY?.toFixed(3)}
                    {r.targetZ != null && `, Z=${r.targetZ.toFixed(3)}`}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <Save className="h-3 w-3" />
                  実測: X={r.measuredX.toFixed(3)}, Y={r.measuredY.toFixed(3)}
                  {r.measuredZ != null && `, Z=${r.measuredZ.toFixed(3)}`}
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

