import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Trash2, Download, FileSearch, RefreshCw, Link as LinkIcon, X } from 'lucide-react'
import { Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore, type SurveyCategory, type StakingRecord, type StakingTargetType } from '@/stores/stakingStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { CoordinateConverter, COORDINATE_TYPE_NAMES, type CoordinateType } from '@/lib/coordinates'
import { supabase } from '@/lib/supabase'

// 実測点 用 の 円形 divIcon を 生成。 Marker (HTML) として markerPane に
// 描画 する ので、SVG の CircleMarker と 違って クリック 受け取り が 安定。
// state (通常 / 選択中 / pending-m1) を 色 と サイズ で 表現。
function createMeasuredIcon(opts: {
  fill: string
  isSelected: boolean
  isPending: boolean
}): L.DivIcon {
  const size = opts.isPending ? 20 : opts.isSelected ? 16 : 12
  const borderWidth = opts.isPending ? 3 : opts.isSelected ? 3 : 2
  const borderColor = opts.isPending ? '#a855f7' : opts.isSelected ? '#1d4ed8' : '#fff'
  return L.divIcon({
    className: 'staking-measured-marker',
    html: `<div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${opts.fill};
      border: ${borderWidth}px solid ${borderColor};
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      cursor: pointer;
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 座標管理 の 点種 色 (CoordinateMap の MARKER_COLORS と 合わせる)。
const TYPE_COLORS: Record<string, string> = {
  control: '#ef4444',
  boundary: '#3b82f6',
  current: '#14b8a6',
  underdrain: '#22c55e',
  soil_import: '#f59e0b',
  stake: '#22c55e',
  map_xml: '#a855f7',
  national_survey: '#d97706',
  cadastral_diagram: '#0891b2',
  witness: '#eab308',
  confirmed_boundary: '#16a34a',
  measured: '#ec4899',
}

// 選択された 記録 の 位置 に 地図 を pan/zoom する 子コンポーネント。
// CoordinateMap の children として 差し込む と useMap で 中の Leaflet Map を 取得できる。
function RecordZoomController({
  target,
}: {
  target: { lat: number; lng: number; tick: number } | null
}) {
  const map = useMap()
  const lastTickRef = useRef<number>(-1)
  useEffect(() => {
    if (!target) return
    if (target.tick === lastTickRef.current) return
    lastTickRef.current = target.tick
    const nextZoom = Math.max(map.getZoom(), 19)
    map.flyTo([target.lat, target.lng], nextZoom, { duration: 0.6 })
  }, [target, map])
  return null
}

// 起工測量・出来形測量の実測記録を一覧表示し、SIMA/CSV で出力するページ。
// 工区横断のトップレベル経路 /staking-records に紐付け。

const CATEGORY_LABEL: Record<SurveyCategory | 'all', string> = {
  all: '全て',
  initial: '起工測量',
  asbuilt: '出来形測量',
}

export function StakingRecordsPage() {
  const { currentFarm } = useFarmStore()
  const {
    records,
    loading,
    error,
    fetchRecords,
    deleteRecord,
    updateRecordTarget,
    pairRecords,
    unpairRecord,
    updateRecordName,
  } = useStakingStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { projects } = useProjectListStore()
  const [filter, setFilter] = useState<'all' | SurveyCategory>('all')

  // 設計座標 の 事後リンク 対象 の 記録 ID。 セット されている 間は 地図クリック
  // で 選んだ 座標 を その 記録 に 割り付ける。
  const [pendingLinkRecordId, setPendingLinkRecordId] = useState<string | null>(null)

  // 「別の 実測点 を 実測2 として 割り付ける」モード。 保持する のは m1 の
  // 記録 ID。 m1 が 設計座標 リンク済み なら updateRecordTarget で 同じ
  // targetRefId に 移動、free なら pairRecords で 対称ペアリング する。
  const [pendingLinkM2ForM1Id, setPendingLinkM2ForM1Id] = useState<string | null>(null)
  // React-leaflet の eventHandlers が 古い クロージャ を 掴んで しまう ケース に
  // 備えて、常に 最新値 を 参照 できる ref も 用意 する。
  const pendingLinkM2ForM1IdRef = useRef<string | null>(null)
  useEffect(() => {
    pendingLinkM2ForM1IdRef.current = pendingLinkM2ForM1Id
  }, [pendingLinkM2ForM1Id])

  // 行 選択 (ハイライト + 地図 ズーム)。 tick は 同じ 行 を 連打 した 時 でも
  // 再ズーム できる ように 単調増加 させる。
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [zoomTick, setZoomTick] = useState<number>(0)

  // 地図に 表示する 点種 の フィルタ (座標管理 の visibleTypes と 同じ 概念)。
  // null = 未初期化 (初回 に availableTypes で 全 ON 初期化)。
  const [visibleTypesState, setVisibleTypesState] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (currentFarm) {
      fetchRecords(currentFarm.id)
      fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm, fetchRecords, fetchCoordinates])

  // 座標系: プロジェクト の 平面直角 系。 実測 XY → lat/lng 変換 に 使用。
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    return projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // 実測点 (measuredX/Y) を lat/lng に 変換 して 地図に 表示 する ため の 集合。
  const measuredPointsForMap = useMemo(() => {
    return records
      .map((r) => {
        const ll = converter.toLatLng(r.measuredX, r.measuredY)
        if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null
        return {
          id: r.id,
          lat: ll.lat,
          lng: ll.lng,
          record: r,
        }
      })
      .filter((x): x is { id: string; lat: number; lng: number; record: typeof records[number] } => x !== null)
  }, [records, converter])

  // 既に 設計座標 に リンク 済み の 座標 ID 集合 (checkedCoordIds で 強調表示)。
  const linkedCoordIds = useMemo(() => {
    const s = new Set<string>()
    for (const r of records) {
      if (r.targetType === 'coordinate' && r.targetRefId) s.add(r.targetRefId)
    }
    return s
  }, [records])

  // 工区内 に 存在する 点種 の 一覧 (フィルタ UI 用)。
  const availableTypes = useMemo(() => {
    const s = new Set<string>()
    for (const c of coordinates) s.add(c.type)
    return Array.from(s).sort()
  }, [coordinates])

  // 初回 に visibleTypesState を 全 ON で 初期化。 その後 は ユーザー 操作 に 委ねる。
  useEffect(() => {
    if (visibleTypesState === null && availableTypes.length > 0) {
      setVisibleTypesState(new Set(availableTypes))
    }
  }, [visibleTypesState, availableTypes])

  const effectiveVisibleTypes = visibleTypesState ?? undefined
  const toggleTypeVisibility = (type: string) => {
    setVisibleTypesState((prev) => {
      const cur = prev ?? new Set(availableTypes)
      const next = new Set(cur)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // 選択中 の 行 の 地図ズーム ターゲット (lat/lng + tick)。 tick を 変えて
  // useEffect を 再発火 させる こと で 同じ 行 を 連打 しても 再ズームできる。
  const zoomTarget = useMemo(() => {
    if (!selectedRecordId) return null
    const rec = records.find((r) => r.id === selectedRecordId)
    if (!rec) return null
    const ll = converter.toLatLng(rec.measuredX, rec.measuredY)
    if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null
    return { lat: ll.lat, lng: ll.lng, tick: zoomTick }
  }, [selectedRecordId, records, converter, zoomTick])

  // 行 クリック で 選択 + ズーム 発火 (連打 対応 の tick インクリメント)。
  const handleRowClick = (recordId: string) => {
    setSelectedRecordId(recordId)
    setZoomTick((t) => t + 1)
  }

  // 「実測2 として 割り付け」モード の 起点 と キャンセル。 排他制御 の ため
  // 他モード は 同時に クリア する。
  const handleStartLinkM2 = (m1Id: string) => {
    setPendingLinkM2ForM1Id(m1Id)
    setPendingLinkRecordId(null)
  }
  const handleCancelLinkM2 = () => setPendingLinkM2ForM1Id(null)

  // 実測マーカー クリック は 単純 に 行選択 + ズーム のみ。
  // 実測2 の 割り付け は 「同じ 位置 を 何度 も 測る」 性質上 マーカー が
  // ほぼ 重なる ため、地図クリック で は 選び分け が 不可能。 代わりに
  // 🔗 ボタン → モーダル で 5cm 以内 の 候補 リスト から 選ぶ 方式 に する。
  const handleMeasuredMarkerClick = (recordId: string) => {
    handleRowClick(recordId)
  }

  // 実測1 の 記録 (XY) に 対して 半径 5cm 以内 の 他 の 実測点 を 候補 として
  // 列挙 (実測2 リンク 用)。 pendingLinkM2ForM1Id が セット されて いる 間 だけ
  // 計算。 既 に m1 と 同じ グループ の m2 は 除外 する 必要 は ない
  // (通常 は m2 未確定 の 状態 で 開かれる ため 候補 に は 現れ ない)。
  const M2_CANDIDATE_RADIUS = 0.05 // m (5cm)
  interface M2Candidate {
    record: StakingRecord
    distance: number
  }
  const m2Candidates = useMemo<M2Candidate[]>(() => {
    if (!pendingLinkM2ForM1Id) return []
    const m1 = records.find((r) => r.id === pendingLinkM2ForM1Id)
    if (!m1) return []
    const out: M2Candidate[] = []
    for (const r of records) {
      if (r.id === m1.id) continue
      const dx = r.measuredX - m1.measuredX
      const dy = r.measuredY - m1.measuredY
      const d = Math.hypot(dx, dy)
      if (d > M2_CANDIDATE_RADIUS) continue
      out.push({ record: r, distance: d })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out
  }, [pendingLinkM2ForM1Id, records])

  // 候補 の 中 から 1 件 を 選んで 実測2 に 割り付ける。
  const handlePickM2Candidate = (candidateId: string) => {
    const pending = pendingLinkM2ForM1IdRef.current
    if (!pending) return
    const m1 = records.find((r) => r.id === pending)
    if (!m1) {
      setPendingLinkM2ForM1Id(null)
      return
    }
    if (m1.targetType === 'coordinate' && m1.targetRefId) {
      const coord = coordinates.find((c) => c.id === m1.targetRefId)
      if (coord) {
        void updateRecordTarget(candidateId, {
          id: coord.id,
          pointNumber: coord.pointNumber,
          x: coord.x,
          y: coord.y,
          z: coord.z,
        })
      }
    } else {
      void pairRecords(m1.id, candidateId)
    }
    setPendingLinkM2ForM1Id(null)
  }

  // 地図で 座標 が クリック された とき: 設定モード なら 記録に リンク、
  // それ以外 は 何もしない。
  const handleCoordSelectOnMap = (coordId: string) => {
    if (!pendingLinkRecordId) return
    const coord = coordinates.find((c) => c.id === coordId)
    if (!coord) return
    void updateRecordTarget(pendingLinkRecordId, {
      id: coord.id,
      pointNumber: coord.pointNumber,
      x: coord.x,
      y: coord.y,
      z: coord.z,
    })
    setPendingLinkRecordId(null)
  }

  // X/Y/Z 補正値 (実測値に加算)。工区ごとに DB (design_survey_calibration) に
  // 永続化して PC / スマホ間 で 共有 する。 Z 補正 は 従来 localStorage の
  // フォールバック も 参照 (旧環境 互換)。X/Y 補正 は 追加 したての ため
  // DB 直接。
  const zOffsetKey = currentFarm ? `staking:zOffset:${currentFarm.id}` : null
  const [xOffset, setXOffset] = useState<number>(0)
  const [yOffset, setYOffset] = useState<number>(0)
  const [zOffset, setZOffset] = useState<number>(0)
  const [xOffsetInput, setXOffsetInput] = useState<string>('0')
  const [yOffsetInput, setYOffsetInput] = useState<string>('0')
  const [zOffsetInput, setZOffsetInput] = useState<string>('0')
  useEffect(() => {
    if (!currentFarm) {
      setXOffset(0); setXOffsetInput('0')
      setYOffset(0); setYOffsetInput('0')
      setZOffset(0); setZOffsetInput('0')
      return
    }
    let cancelled = false
    void (async () => {
      let dbX: number | null = null
      let dbY: number | null = null
      let dbZ: number | null = null
      try {
        const { data } = await supabase
          .from('design_survey_calibration')
          .select('dx_offset, dy_offset, dz_offset')
          .eq('farm_id', currentFarm.id)
          .maybeSingle()
        const row = data as {
          dx_offset?: number | string | null
          dy_offset?: number | string | null
          dz_offset?: number | string | null
        } | null
        if (row) {
          const vx = row.dx_offset != null ? Number(row.dx_offset) : NaN
          const vy = row.dy_offset != null ? Number(row.dy_offset) : NaN
          const vz = row.dz_offset != null ? Number(row.dz_offset) : NaN
          if (Number.isFinite(vx)) dbX = vx
          if (Number.isFinite(vy)) dbY = vy
          if (Number.isFinite(vz)) dbZ = vz
        }
      } catch { /* noop: 未マイグレーション環境 */ }
      if (cancelled) return
      // Z は localStorage フォールバック 有り
      if (dbZ == null) {
        try {
          const raw = zOffsetKey ? localStorage.getItem(zOffsetKey) : null
          const v = raw != null ? parseFloat(raw) : 0
          dbZ = Number.isFinite(v) ? v : 0
        } catch { dbZ = 0 }
      }
      const x = dbX ?? 0
      const y = dbY ?? 0
      const z = dbZ ?? 0
      setXOffset(x); setXOffsetInput(String(x))
      setYOffset(y); setYOffsetInput(String(y))
      setZOffset(z); setZOffsetInput(String(z))
      if (zOffsetKey) {
        try { localStorage.setItem(zOffsetKey, String(z)) } catch { /* ignore */ }
      }
      // localStorage 由来 の Z が あれば DB に も 書き戻し (一度きり)
      if (dbZ != null && dbX == null && dbY == null && z !== 0) {
        try {
          await supabase
            .from('design_survey_calibration')
            .upsert(
              { farm_id: currentFarm.id, is_enabled: true, dz_offset: z } as never,
              { onConflict: 'farm_id' },
            )
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [currentFarm, zOffsetKey])

  // 補正値 の 保存 (X / Y / Z いずれか の 単一 フィールド 更新)。
  const commitOffset = async (
    axis: 'x' | 'y' | 'z',
    s: string,
  ) => {
    const n = parseFloat(s)
    const next = Number.isFinite(n) ? n : 0
    if (axis === 'x') { setXOffset(next); setXOffsetInput(String(next)) }
    if (axis === 'y') { setYOffset(next); setYOffsetInput(String(next)) }
    if (axis === 'z') {
      setZOffset(next); setZOffsetInput(String(next))
      if (zOffsetKey) {
        try { localStorage.setItem(zOffsetKey, String(next)) } catch { /* ignore */ }
      }
    }
    if (!currentFarm) return
    const patch: Record<string, unknown> = {
      farm_id: currentFarm.id,
      is_enabled: true,
    }
    if (axis === 'x') patch.dx_offset = next
    if (axis === 'y') patch.dy_offset = next
    if (axis === 'z') patch.dz_offset = next
    try {
      const { error } = await supabase
        .from('design_survey_calibration')
        .upsert(patch as never, { onConflict: 'farm_id' })
      if (error) console.warn(`[staking] ${axis.toUpperCase()} 補正 の 保存 に 失敗`, error)
    } catch (err) {
      console.warn(`[staking] ${axis.toUpperCase()} 補正 の 保存 に 失敗`, err)
    }
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return records
    return records.filter((r) => r.surveyCategory === filter)
  }, [records, filter])

  // 同じ 設計座標 に リンク された 実測記録 を 「実測1 / 実測2」に ペアリング。
  // 3 件 以上 ある 場合 は 2 件 ごと に 追加行 を 生成。 フリー / 未リンク は
  // ペアリング せず 単独行 として 扱う。
  interface StakingGroup {
    key: string
    designName: string
    designX: number | null
    designY: number | null
    designZ: number | null
    surveyCategory: SurveyCategory
    targetType: StakingTargetType
    m1: StakingRecord | null
    m2: StakingRecord | null
  }
  const grouped = useMemo<StakingGroup[]>(() => {
    // (1) 設計座標 リンク済み: targetRefId で グループ化
    const byRef = new Map<string, StakingRecord[]>()
    const freeRecords: StakingRecord[] = []
    for (const r of filtered) {
      if (r.targetType === 'coordinate' && r.targetRefId) {
        const arr = byRef.get(r.targetRefId) ?? []
        arr.push(r)
        byRef.set(r.targetRefId, arr)
      } else {
        freeRecords.push(r)
      }
    }
    for (const arr of byRef.values()) {
      arr.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    }
    const out: StakingGroup[] = []
    for (const [refId, arr] of byRef.entries()) {
      const design = arr[0]
      for (let i = 0; i < arr.length; i += 2) {
        out.push({
          key: i === 0 ? refId : `${refId}-${i}`,
          designName: design.targetName ?? '',
          designX: design.targetX,
          designY: design.targetY,
          designZ: design.targetZ,
          surveyCategory: arr[i].surveyCategory,
          targetType: design.targetType,
          m1: arr[i] ?? null,
          m2: arr[i + 1] ?? null,
        })
      }
    }
    // (2) free 記録: pairedWithId で 対称ペア を 束ねる (相互 参照 のみ 有効扱い)
    const freeById = new Map(freeRecords.map((r) => [r.id, r]))
    const consumed = new Set<string>()
    for (const r of freeRecords) {
      if (consumed.has(r.id)) continue
      const partner = r.pairedWithId ? freeById.get(r.pairedWithId) : null
      const isSymmetric = partner && partner.pairedWithId === r.id
      if (partner && isSymmetric && !consumed.has(partner.id)) {
        const pair = [r, partner].sort((a, b) =>
          a.recordedAt.localeCompare(b.recordedAt),
        )
        out.push({
          key: `pair-${pair[0].id}`,
          designName: '',
          designX: null,
          designY: null,
          designZ: null,
          surveyCategory: pair[0].surveyCategory,
          targetType: pair[0].targetType,
          m1: pair[0],
          m2: pair[1],
        })
        consumed.add(pair[0].id)
        consumed.add(pair[1].id)
      } else {
        out.push({
          key: r.id,
          designName: '',
          designX: null,
          designY: null,
          designZ: null,
          surveyCategory: r.surveyCategory,
          targetType: r.targetType,
          m1: r,
          m2: null,
        })
        consumed.add(r.id)
      }
    }
    // 直近 が 先頭 (m1 の 記録日時 降順)
    out.sort((a, b) => {
      const at = a.m1?.recordedAt ?? ''
      const bt = b.m1?.recordedAt ?? ''
      return bt.localeCompare(at)
    })
    return out
  }, [filtered])

  // 平均誤差・件数 の 簡易サマリ。 平均 dX / dY は 実測平均 と 設計 の 生 の 差
  // (実測 - 設計) を グループ 全体 で 平均。 スライド量 を どう 設定 すれば 良い か
  // の 参考値 に なる (この 値 を そのまま 入力 すれば 中央値 が 揃う)。
  const summary = useMemo(() => {
    let stakeCount = 0
    let freeCount = 0
    for (const r of filtered) {
      if (r.targetType === 'free') freeCount++
      else stakeCount++
    }
    let sumDvsX = 0
    let sumDvsY = 0
    let sumDist2 = 0
    let pairs = 0
    for (const g of grouped) {
      if (g.designX == null || g.designY == null || !g.m1) continue
      const avgMX = g.m2 ? (g.m1.measuredX + g.m2.measuredX) / 2 : g.m1.measuredX
      const avgMY = g.m2 ? (g.m1.measuredY + g.m2.measuredY) / 2 : g.m1.measuredY
      // 生 の 差 (実測平均 - 設計)。 補正 を 掛ける 前 の バイアス。
      const dvsX = avgMX - g.designX
      const dvsY = avgMY - g.designY
      sumDvsX += dvsX
      sumDvsY += dvsY
      sumDist2 += dvsX * dvsX + dvsY * dvsY
      pairs++
    }
    const avgDx = pairs > 0 ? sumDvsX / pairs : null
    const avgDy = pairs > 0 ? sumDvsY / pairs : null
    const rms = pairs > 0 ? Math.sqrt(sumDist2 / pairs) : null
    return {
      total: filtered.length,
      stake: stakeCount,
      free: freeCount,
      rms,
      avgDx,
      avgDy,
      pairs,
    }
  }, [filtered, grouped])

  const handleDelete = async (id: string, name: string | null) => {
    if (!confirm(`記録「${name ?? '(無題)'}」を削除しますか？`)) return
    await deleteRecord(id)
  }

  // CSV 出力（実測値ベース）
  const handleExportCSV = () => {
    if (filtered.length === 0) return
    const header =
      '点名,測量種別,X(実測),Y(実測),Z(実測),X(逆スライド),Y(逆スライド),Z(逆スライド),X(計画),Y(計画),Z(計画),精度(m),サンプル数,記録日時\n'
    const rows = filtered
      .map((r) =>
        [
          r.targetName ?? '',
          CATEGORY_LABEL[r.surveyCategory],
          r.measuredX.toFixed(3),
          r.measuredY.toFixed(3),
          r.measuredZ != null ? r.measuredZ.toFixed(3) : '',
          (r.measuredX - xOffset).toFixed(3),
          (r.measuredY - yOffset).toFixed(3),
          r.measuredZ != null ? (r.measuredZ - zOffset).toFixed(3) : '',
          r.targetX != null ? r.targetX.toFixed(3) : '',
          r.targetY != null ? r.targetY.toFixed(3) : '',
          r.targetZ != null ? r.targetZ.toFixed(3) : '',
          r.accuracy != null ? r.accuracy.toFixed(3) : '',
          r.sampleCount ?? '',
          r.recordedAt,
        ].join(','),
      )
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const farmName = currentFarm?.name ?? 'farm'
    a.href = url
    a.download = `${farmName}_staking_records.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // SIMA 出力（実測値ベース）
  // フォーマットは PipeCoordinateCalcPage の handleExportSIMA に準拠。
  const handleExportSIMA = () => {
    if (filtered.length === 0) return
    const projectName = currentFarm?.name || 'NoName'
    const lines: string[] = []
    lines.push(`G00,04,${projectName},`)
    lines.push('Z00, /* 起工測量実測座標 */,')
    lines.push('Z01,2,')
    lines.push('A00,')
    filtered.forEach((r, index) => {
      const name = r.targetName ?? `pt-${index + 1}`
      const paddedName = name.padEnd(20, ' ')
      // 逆スライド実測 (実測平均 - スライド量) を 出力 の 既定 と する。
      const xStr = (r.measuredX - xOffset).toFixed(3).padStart(10, ' ')
      const yStr = (r.measuredY - yOffset).toFixed(3).padStart(10, ' ')
      const zStr =
        r.measuredZ != null ? (r.measuredZ - zOffset).toFixed(3).padStart(10, ' ') : ''
      const numStr = (index + 1).toString().padStart(5, ' ')
      lines.push(`A01,${numStr},${paddedName},${xStr},${yStr},${zStr},`)
    })
    lines.push('A99,')
    const content = lines.join('\r\n')
    const blob = new Blob([content], { type: 'text/plain;charset=shift_jis' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}_staking.sim`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full w-full min-w-0 max-w-full flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="px-4 py-3 border-b bg-white flex items-center gap-2 flex-wrap">
        <FileSearch className="h-4 w-4 text-slate-500" />
        <span className="font-medium">起工測量 実測記録</span>
        <span className="text-xs text-slate-500">{currentFarm.name}</span>

        <div className="ml-4 flex items-center gap-1 text-xs">
          {(['all', 'initial', 'asbuilt'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-2 py-1 rounded border ${
                filter === c
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'hover:bg-slate-50'
              }`}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* 補正: 実測値 に 加算する 定数オフセット (X / Y / Z 独立)。
              GPS 系統差 や 基準点 の ずれ を 素早く 吸収する 簡易補正。 */}
          <span
            className="text-[11px] text-slate-500"
            title="実測値 に この 値 (m) を 加算した 「補正 XYZ」を 表示。 表 の 平均 と 差 も 補正 後 の 値 で 計算"
          >
            スライド量 (m):
          </span>
          <label className="flex items-center gap-1 text-xs">
            <span className="text-slate-500">X</span>
            <input
              type="number"
              step={0.001}
              value={xOffsetInput}
              onChange={(e) => setXOffsetInput(e.target.value)}
              onBlur={(e) => void commitOffset('x', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="w-20 px-1.5 py-0.5 border rounded text-right font-mono"
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <span className="text-slate-500">Y</span>
            <input
              type="number"
              step={0.001}
              value={yOffsetInput}
              onChange={(e) => setYOffsetInput(e.target.value)}
              onBlur={(e) => void commitOffset('y', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="w-20 px-1.5 py-0.5 border rounded text-right font-mono"
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <span className="text-slate-500">Z</span>
            <input
              type="number"
              step={0.001}
              value={zOffsetInput}
              onChange={(e) => setZOffsetInput(e.target.value)}
              onBlur={(e) => void commitOffset('z', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="w-20 px-1.5 py-0.5 border rounded text-right font-mono"
            />
          </label>
          <button
            onClick={() => fetchRecords(currentFarm.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
            title="再読み込み"
          >
            <RefreshCw className="h-3 w-3" />
            再読込
          </button>
          <button
            onClick={handleExportCSV}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            onClick={handleExportSIMA}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            SIMA
          </button>
        </div>
      </div>

      {/* サマリ (幅 が 狭い とき は 折り返し) */}
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-4 text-xs text-slate-600 flex-wrap">
        <span>合計 <span className="font-semibold">{summary.total}</span> 件</span>
        <span>測設 <span className="font-semibold">{summary.stake}</span> / フリー <span className="font-semibold">{summary.free}</span></span>
        {summary.avgDx != null && summary.avgDy != null && (
          <>
            <span>
              平均 dX: <span className="font-mono font-semibold">{summary.avgDx.toFixed(4)}</span> m
            </span>
            <span>
              平均 dY: <span className="font-mono font-semibold">{summary.avgDy.toFixed(4)}</span> m
            </span>
          </>
        )}
        {summary.rms != null && (
          <span>
            RMS: <span className="font-mono font-semibold">{summary.rms.toFixed(3)}</span> m
            <span className="text-slate-400 ml-1">(n={summary.pairs})</span>
          </span>
        )}
        {pendingLinkRecordId && (
          <span className="ml-auto flex items-center gap-2 text-blue-700 font-semibold">
            📍 地図上の 設計座標 を クリック で 割り付け
            <button
              onClick={() => setPendingLinkRecordId(null)}
              className="p-0.5 rounded border hover:bg-white"
              title="キャンセル"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        {pendingLinkM2ForM1Id && (
          <span className="ml-auto flex items-center gap-2 text-purple-700 font-semibold">
            🎯 実測2 の 候補 を 選択 (5cm 以内 の 実測点)
            <button
              onClick={handleCancelLinkM2}
              className="p-0.5 rounded border hover:bg-white"
              title="キャンセル"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>

      {/* 点種 フィルタ (座標管理 の visibleTypes と 同じ 考え方)。 工区内 に
          存在する 点種 だけ を チップ で 出し、クリック で ON/OFF。 */}
      {availableTypes.length > 0 && (
        <div className="px-3 py-1.5 border-b bg-white flex items-center gap-1 flex-wrap">
          <span className="text-[11px] text-slate-500 mr-1">表示点種:</span>
          {availableTypes.map((type) => {
            const on = effectiveVisibleTypes?.has(type) ?? true
            const color = TYPE_COLORS[type] ?? '#666'
            const label = COORDINATE_TYPE_NAMES[type as CoordinateType] ?? type
            return (
              <button
                key={type}
                onClick={() => toggleTypeVisibility(type)}
                title={on ? '非表示に する' : '表示する'}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] border rounded ${
                  on
                    ? 'bg-white border-slate-300 text-slate-700'
                    : 'bg-slate-100 border-slate-200 text-slate-400 line-through'
                }`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color, opacity: on ? 1 : 0.3 }}
                />
                {label}
              </button>
            )
          })}
          <button
            onClick={() => setVisibleTypesState(new Set(availableTypes))}
            className="ml-auto text-[11px] text-slate-500 hover:text-blue-600"
          >
            全 ON
          </button>
          <button
            onClick={() => setVisibleTypesState(new Set())}
            className="text-[11px] text-slate-500 hover:text-blue-600"
          >
            全 OFF
          </button>
        </div>
      )}

      {/* 上半分: 地図 (座標管理 と 同じ CoordinateMap)。設計座標 を クリック
          で 事後リンク 可能。実測点 は オレンジ 十字マーカー で 表示。
          overflow-hidden + isolate で 地図 内 の z-[1000] HUD が 下 の テーブル
          に 被らない ように 独立 スタッキング コンテキスト を 作る。 */}
      <div className="flex-1 min-h-0 border-b-2 border-slate-300 relative overflow-hidden isolate">
        <CoordinateMap
          farmId={currentFarm.id}
          showLabels
          visibleTypes={effectiveVisibleTypes}
          // 実測記録 と リンク 済み の 設計座標 は 実測点マーカー が 主役 に
          // なる ので dim (小さく + 半透明 + ラベル 非表示 + zIndex 後退) する。
          dimmedCoordIds={linkedCoordIds}
          onPointSelect={handleCoordSelectOnMap}
        >
          {/* 行 選択時 の 地図 pan/zoom */}
          <RecordZoomController target={zoomTarget} />
          {/* 誤差ベクトル (設計座標 と リンク 済み 実測点 を つなぐ 破線)。
              単なる 描画 レイヤー なので デフォルト overlayPane で OK。 */}
          {measuredPointsForMap.map((m) => {
            const linkedCoord =
              m.record.targetType === 'coordinate' && m.record.targetRefId
                ? coordinates.find((c) => c.id === m.record.targetRefId)
                : null
            if (!linkedCoord) return null
            const linkedLL = converter.toLatLng(linkedCoord.x, linkedCoord.y)
            return (
              <Polyline
                key={`line-${m.id}`}
                positions={[
                  [linkedLL.lat, linkedLL.lng],
                  [m.lat, m.lng],
                ]}
                pathOptions={{
                  color: '#f97316',
                  weight: 1.5,
                  opacity: 0.7,
                  dashArray: '3,3',
                }}
              />
            )
          })}
          {/* 実測点マーカー は Marker (HTML divIcon) で 描画。 CircleMarker (SVG) は
              custom pane に 入れて も 一部 環境 で クリック が 通らない ケース が
              あった ため、確実 に クリック を 受け取れる Marker + divIcon に 変更。
              zIndexOffset=1000 で 設計座標 マーカー (offset 0) より 上に。 */}
          {measuredPointsForMap.map((m) => {
            const isSelected = selectedRecordId === m.id
            const isPending = pendingLinkM2ForM1Id === m.id
            const fill = m.record.surveyCategory === 'asbuilt' ? '#10b981' : '#f97316'
            return (
              <Marker
                key={`meas-${m.id}`}
                position={[m.lat, m.lng]}
                icon={createMeasuredIcon({ fill, isSelected, isPending })}
                zIndexOffset={isPending ? 2000 : 1000}
                eventHandlers={{
                  click: () => handleMeasuredMarkerClick(m.id),
                }}
              >
                <Tooltip
                  permanent
                  direction="right"
                  offset={[10, 0]}
                  className="point-label-tooltip"
                >
                  <span
                    style={{
                      color: fill,
                      textShadow:
                        '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                    }}
                  >
                    {m.record.targetName ?? '(実測)'}
                  </span>
                </Tooltip>
              </Marker>
            )
          })}
        </CoordinateMap>
      </div>

      {/* 下半分: テーブル (isolate で テーブル 内 の sticky thead の z-index が
          地図側 と 干渉 しない ように 独立 スタッキング コンテキスト を 作る) */}
      <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-white isolate">
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            記録がありません
          </div>
        ) : (
          <table className="min-w-max text-xs border-collapse whitespace-nowrap">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-slate-700">
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>種別</th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-slate-50"
                  colSpan={4}
                >
                  設計
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-orange-50"
                  colSpan={4}
                  title="1 回目 の 実測"
                >
                  実測1
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-orange-50"
                  colSpan={4}
                  title="2 回目 の 実測。 別 の 実測点 を リンク で 割り付け 可能。"
                >
                  実測2
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-rose-50"
                  colSpan={3}
                  title="実測1 と 実測2 の 差 (実測2 - 実測1)"
                >
                  実測差
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-emerald-50"
                  colSpan={3}
                  title="実測1 と 実測2 の 平均 (実測2 が 無ければ 実測1)。 生値。"
                >
                  実測平均
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-blue-50"
                  colSpan={4}
                  title="設計 と 実測平均 の 生 の 差 (実測平均 - 設計)。 水平 = √(dX²+dY²)。 この 値 を スライド量 に 入れると 中央値 が 揃う。"
                >
                  実測平均 - 設計
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-fuchsia-50"
                  colSpan={3}
                  title="スライド補正: 設計値 を 実測 に 近づける。 設計 + スライド量。"
                >
                  スライド設計
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-cyan-50"
                  colSpan={3}
                  title="逆スライド補正: 実測平均 を 設計 に 近づける。 実測平均 - スライド量。 出力 の 既定。"
                >
                  逆スライド実測
                </th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>精度(m)</th>
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>記録日時</th>
                <th className="px-2 py-2 border-b text-center w-10" rowSpan={2}></th>
              </tr>
              <tr className="text-slate-700">
                <th className="px-2 py-1 border-b border-r text-left">点名</th>
                <th className="px-2 py-1 border-b border-r text-right">X</th>
                <th className="px-2 py-1 border-b border-r text-right">Y</th>
                <th className="px-2 py-1 border-b border-r text-right">Z</th>
                <th className="px-2 py-1 border-b border-r text-left bg-orange-50">点名</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Z</th>
                <th className="px-2 py-1 border-b border-r text-left bg-orange-50">点名</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Z</th>
                <th className="px-2 py-1 border-b border-r text-right bg-rose-50">dX</th>
                <th className="px-2 py-1 border-b border-r text-right bg-rose-50">dY</th>
                <th className="px-2 py-1 border-b border-r text-right bg-rose-50">dZ</th>
                <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">Z</th>
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">dX</th>
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">dY</th>
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">dZ</th>
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">水平</th>
                <th className="px-2 py-1 border-b border-r text-right bg-fuchsia-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-fuchsia-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-fuchsia-50">Z</th>
                <th className="px-2 py-1 border-b border-r text-right bg-cyan-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-cyan-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-cyan-50">Z</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => {
                const { m1, m2 } = g
                const isSelected = selectedRecordId === g.m1?.id
                // 点名: 実測1 の targetName → G_ / G2_ プレフィックス を 剥がした 設計名
                const designName =
                  g.targetType === 'coordinate' && g.designName
                    ? g.designName.replace(/^G2?_/, '')
                    : m1?.targetName ?? '(無題)'
                // 差 (m2 - m1)
                const diffX = m1 && m2 ? m2.measuredX - m1.measuredX : null
                const diffY = m1 && m2 ? m2.measuredY - m1.measuredY : null
                const diffZ =
                  m1 && m2 && m1.measuredZ != null && m2.measuredZ != null
                    ? m2.measuredZ - m1.measuredZ
                    : null
                // 平均 (m2 が あれば 平均、無ければ m1)
                const avgX =
                  m1 && m2 ? (m1.measuredX + m2.measuredX) / 2 : m1?.measuredX ?? null
                const avgY =
                  m1 && m2 ? (m1.measuredY + m2.measuredY) / 2 : m1?.measuredY ?? null
                const avgZ =
                  m1 && m2 && m1.measuredZ != null && m2.measuredZ != null
                    ? (m1.measuredZ + m2.measuredZ) / 2
                    : m1?.measuredZ ?? null
                // 実測平均 - 設計 (生 の 差、補正 適用前 の バイアス)
                const dvsX =
                  avgX != null && g.designX != null ? avgX - g.designX : null
                const dvsY =
                  avgY != null && g.designY != null ? avgY - g.designY : null
                const dvsZ =
                  avgZ != null && g.designZ != null ? avgZ - g.designZ : null
                const dvsH = dvsX != null && dvsY != null ? Math.hypot(dvsX, dvsY) : null
                // スライド設計 (方式 A): 設計値 に スライド量 を 加算 して 実測 に 寄せる
                //   スライド設計 X = 設計 X + xOffset
                const slidedDX = g.designX != null ? g.designX + xOffset : null
                const slidedDY = g.designY != null ? g.designY + yOffset : null
                const slidedDZ = g.designZ != null ? g.designZ + zOffset : null
                // 逆スライド実測 (方式 B): 実測平均 から スライド量 を 引いて 設計 に 寄せる
                //   逆スライド実測 X = 実測平均 X - xOffset (出力 の 既定)
                const revSlideMX = avgX != null ? avgX - xOffset : null
                const revSlideMY = avgY != null ? avgY - yOffset : null
                const revSlideMZ = avgZ != null ? avgZ - zOffset : null
                // 精度: m1 と m2 の 悪い方 (Max) を 表示 (未取得 は 除外)
                const acc =
                  m1?.accuracy != null && m2?.accuracy != null
                    ? Math.max(m1.accuracy, m2.accuracy)
                    : m1?.accuracy ?? m2?.accuracy ?? null
                const clickId = m1?.id ?? null
                return (
                  <tr
                    key={g.key}
                    onClick={() => clickId && handleRowClick(clickId)}
                    className={`cursor-pointer ${
                      isSelected ? 'bg-blue-100 hover:bg-blue-200' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-2 py-1.5 border-b border-r">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          g.targetType === 'free'
                            ? 'bg-amber-100 text-amber-800'
                            : g.targetType === 'pipe_vertex'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {g.targetType === 'free'
                          ? 'フリー'
                          : g.targetType === 'pipe_vertex'
                            ? '頂点'
                            : '座標'}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-500">
                        {CATEGORY_LABEL[g.surveyCategory]}
                      </span>
                      {m2 && (
                        <span
                          className="ml-1 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700"
                          title="2 回 測定"
                        >
                          ×2
                        </span>
                      )}
                    </td>
                    {/* 設計 (点名 + XYZ + リンク 操作 ボタン) — 実測1 の record を 対象 */}
                    <td
                      className={`px-2 py-1.5 border-b border-r font-medium ${
                        m1 && pendingLinkRecordId === m1.id
                          ? 'bg-blue-100 text-blue-800'
                          : 'text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="flex-1 min-w-0 truncate">
                          {g.targetType === 'coordinate' && g.designName ? (
                            designName
                          ) : (
                            <span className="text-slate-400 italic">未設定</span>
                          )}
                        </span>
                        {g.targetType === 'coordinate' && m1?.targetRefId ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              // グループ 内 全 record を 一斉 に 解除
                              const ids = [m1?.id, m2?.id].filter(Boolean) as string[]
                              for (const id of ids) void updateRecordTarget(id, null)
                            }}
                            title="設計座標 の リンク を 解除 (グループ 全体)"
                            className="p-0.5 text-slate-400 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 && pendingLinkRecordId === m1.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingLinkRecordId(null)
                            }}
                            title="設計座標 の 選択 を キャンセル"
                            className="p-0.5 text-blue-600 hover:bg-blue-200 rounded"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingLinkRecordId(m1.id)
                              setPendingLinkM2ForM1Id(null)
                            }}
                            title="地図 から 設計座標 を 選んで リンク"
                            className="p-0.5 text-blue-500 hover:bg-blue-50 rounded"
                          >
                            <LinkIcon className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {g.designX != null ? g.designX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {g.designY != null ? g.designY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {g.designZ != null ? g.designZ.toFixed(3) : '—'}
                    </td>
                    {/* 実測1 (点名 / X / Y / Z)。 点名 は 変更可 (blur/Enter で 保存)、
                        座標 (X/Y/Z) は 読取専用。 */}
                    <td className="px-1 py-1 border-b border-r bg-orange-50/50 max-w-[8rem]">
                      {m1 ? (
                        <input
                          type="text"
                          key={`${m1.id}:${m1.targetName ?? ''}`}
                          defaultValue={m1.targetName ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (m1.targetName ?? '')) {
                              void updateRecordName(m1.id, v || null)
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              (e.currentTarget as HTMLInputElement).blur()
                          }}
                          className="w-full px-1 py-0.5 border rounded text-sm bg-white"
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1?.measuredZ != null ? m1.measuredZ.toFixed(3) : '—'}
                    </td>
                    {/* 実測2 (点名 + リンク操作 / X / Y / Z)。 別 の 実測点 を リンク
                        させる こと で 「後追い で 2 回目 の 実測」を 表現できる。 */}
                    <td
                      className={`px-1 py-1 border-b border-r max-w-[8rem] ${
                        m1 && pendingLinkM2ForM1Id === m1.id
                          ? 'bg-purple-100'
                          : 'bg-orange-50/50'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        {m2 ? (
                          <input
                            type="text"
                            key={`${m2.id}:${m2.targetName ?? ''}`}
                            defaultValue={m2.targetName ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                              if (v !== (m2.targetName ?? '')) {
                                void updateRecordName(m2.id, v || null)
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                (e.currentTarget as HTMLInputElement).blur()
                            }}
                            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-sm bg-white"
                          />
                        ) : (
                          <span className="flex-1 min-w-0 truncate text-slate-400 italic">
                            —
                          </span>
                        )}
                        {m2 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              // グループ 種別 に 応じて 解除方法 を 切替:
                              // 設計座標 リンク済み → updateRecordTarget(null) で free 化
                              // free ペア → unpairRecord で 双方 の paired_with_id を NULL
                              if (m1?.targetType === 'coordinate' && m1.targetRefId) {
                                void updateRecordTarget(m2.id, null)
                              } else {
                                void unpairRecord(m2.id)
                              }
                            }}
                            title="実測2 を グループ から 外す"
                            className="p-0.5 text-slate-400 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 && pendingLinkM2ForM1Id === m1.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleCancelLinkM2()
                            }}
                            title="キャンセル"
                            className="p-0.5 text-purple-600 hover:bg-purple-200 rounded"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleStartLinkM2(m1.id)
                            }}
                            title="別 の 実測点 を 実測2 として リンク"
                            className="p-0.5 text-purple-500 hover:bg-purple-50 rounded"
                          >
                            <LinkIcon className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2?.measuredZ != null ? m2.measuredZ.toFixed(3) : '—'}
                    </td>
                    {/* 実測差 (m2 - m1) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                      {diffX != null ? diffX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                      {diffY != null ? diffY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                      {diffZ != null ? diffZ.toFixed(3) : '—'}
                    </td>
                    {/* 平均 (X/Y/Z) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                      {avgX != null ? avgX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                      {avgY != null ? avgY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                      {avgZ != null ? avgZ.toFixed(3) : '—'}
                    </td>
                    {/* 平均 - 設計 (dX / dY / dZ / 水平) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsX != null ? dvsX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsY != null ? dvsY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsZ != null ? dvsZ.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsH != null ? dvsH.toFixed(3) : '—'}
                    </td>
                    {/* スライド設計 = 設計 + スライド量 (設計 を 実測 に 近づける) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-fuchsia-50/50">
                      {slidedDX != null ? slidedDX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-fuchsia-50/50">
                      {slidedDY != null ? slidedDY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-fuchsia-50/50">
                      {slidedDZ != null ? slidedDZ.toFixed(3) : '—'}
                    </td>
                    {/* 逆スライド実測 = 実測平均 - スライド量 (実測 を 設計 に 近づける、出力 の 既定) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-cyan-50/50 font-semibold">
                      {revSlideMX != null ? revSlideMX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-cyan-50/50 font-semibold">
                      {revSlideMY != null ? revSlideMY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-cyan-50/50 font-semibold">
                      {revSlideMZ != null ? revSlideMZ.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {acc != null ? acc.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r text-slate-600">
                      {m1
                        ? new Date(m1.recordedAt).toLocaleString('ja-JP', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b text-center">
                      <div className="flex gap-0.5 justify-center">
                        {m1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDelete(m1.id, m1.targetName)
                            }}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                            title="実測1 を 削除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                        {m2 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDelete(m2.id, m2.targetName)
                            }}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded text-[9px]"
                            title="実測2 を 削除"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span className="text-[9px] absolute">2</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 実測2 選択 モーダル: 5cm 以内 の 候補 リスト から 選ぶ。
          地図上 で は 実測1 と ほぼ 重なる ため マーカー クリック では
          選び分け が 難しい ので、この 方式 に した。 */}
      {pendingLinkM2ForM1Id && (() => {
        const m1 = records.find((r) => r.id === pendingLinkM2ForM1Id)
        if (!m1) return null
        return (
          <div
            className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4"
            onClick={handleCancelLinkM2}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b flex items-center gap-2">
                <div className="font-semibold text-sm">実測2 を 選択</div>
                <div className="text-xs text-slate-500 ml-auto">
                  基準: <span className="font-mono">{m1.targetName ?? '(無題)'}</span>{' '}
                  ({m1.measuredX.toFixed(3)}, {m1.measuredY.toFixed(3)})
                </div>
                <button
                  onClick={handleCancelLinkM2}
                  className="p-1 rounded hover:bg-slate-100"
                  title="閉じる"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-2 text-[11px] text-slate-500 border-b">
                実測1 の XY から 5cm 以内 の 実測点 を 一覧。 別 グループ に 属する
                記録 も 含む (選択 で 移動 する)。
              </div>
              <div className="flex-1 overflow-auto">
                {m2Candidates.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    5cm 以内 に 他 の 実測点 が ありません。
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">点名</th>
                        <th className="px-2 py-1 text-right">距離 (mm)</th>
                        <th className="px-2 py-1 text-right">X</th>
                        <th className="px-2 py-1 text-right">Y</th>
                        <th className="px-2 py-1 text-left">現状</th>
                        <th className="px-2 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {m2Candidates.map(({ record, distance }) => {
                        const status =
                          record.targetType === 'coordinate' && record.targetRefId
                            ? '別設計座標 に リンク'
                            : record.pairedWithId
                              ? '既 ペア あり'
                              : 'free'
                        return (
                          <tr key={record.id} className="border-t hover:bg-slate-50">
                            <td className="px-2 py-1 font-medium">
                              {record.targetName ?? '(無題)'}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {(distance * 1000).toFixed(1)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {record.measuredX.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {record.measuredY.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-xs text-slate-500">
                              {status}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                onClick={() => handlePickM2Candidate(record.id)}
                                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                              >
                                これを 実測2 に
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="px-4 py-2 border-t flex justify-end">
                <button
                  onClick={handleCancelLinkM2}
                  className="px-3 py-1 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
