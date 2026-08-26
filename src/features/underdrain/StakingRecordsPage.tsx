import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Trash2, Download, FileSearch, RefreshCw, Link as LinkIcon, X } from 'lucide-react'
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore, type SurveyCategory, type StakingRecord, type StakingTargetType } from '@/stores/stakingStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { CoordinateConverter, COORDINATE_TYPE_NAMES, type CoordinateType } from '@/lib/coordinates'
import { supabase } from '@/lib/supabase'

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
  const { records, loading, error, fetchRecords, deleteRecord, updateRecordTarget } = useStakingStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { projects } = useProjectListStore()
  const [filter, setFilter] = useState<'all' | SurveyCategory>('all')

  // 設計座標 の 事後リンク 対象 の 記録 ID。 セット されている 間は 地図クリック
  // で 選んだ 座標 を その 記録 に 割り付ける。
  const [pendingLinkRecordId, setPendingLinkRecordId] = useState<string | null>(null)

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

  // Z 補正値 (実測値に加算)。工区ごとに DB (design_survey_calibration.dz_offset)
  // に永続化することで PC/スマホ間で共有可能に。localStorage は旧値のフォール
  // バックとしてだけ参照 (初回だけ DB に移行)。
  const zOffsetKey = currentFarm ? `staking:zOffset:${currentFarm.id}` : null
  const [zOffset, setZOffset] = useState<number>(0)
  const [zOffsetInput, setZOffsetInput] = useState<string>('0')
  useEffect(() => {
    if (!currentFarm) {
      setZOffset(0)
      setZOffsetInput('0')
      return
    }
    let cancelled = false
    void (async () => {
      // まず DB から取得
      let dbValue: number | null = null
      try {
        const { data } = await supabase
          .from('design_survey_calibration')
          .select('dz_offset')
          .eq('farm_id', currentFarm.id)
          .maybeSingle()
        const row = data as { dz_offset: number | string } | null
        if (row?.dz_offset != null) {
          const v = Number(row.dz_offset)
          if (Number.isFinite(v)) dbValue = v
        }
      } catch { /* noop: 未マイグレーション環境等 */ }
      if (cancelled) return
      if (dbValue != null) {
        setZOffset(dbValue)
        setZOffsetInput(String(dbValue))
        // ついでに localStorage も更新して他画面 (施工計画) と揃える
        if (zOffsetKey) {
          try { localStorage.setItem(zOffsetKey, String(dbValue)) } catch { /* ignore */ }
        }
        return
      }
      // DB に無い場合 → localStorage フォールバック
      let lsValue = 0
      try {
        const raw = zOffsetKey ? localStorage.getItem(zOffsetKey) : null
        const v = raw != null ? parseFloat(raw) : 0
        lsValue = Number.isFinite(v) ? v : 0
      } catch { lsValue = 0 }
      setZOffset(lsValue)
      setZOffsetInput(String(lsValue))
      // localStorage に値があれば DB にも書いておく (端末→共有への一回きり移行)
      if (lsValue !== 0) {
        try {
          await supabase
            .from('design_survey_calibration')
            .upsert(
              {
                farm_id: currentFarm.id,
                is_enabled: true,
                dz_offset: lsValue,
              } as never,
              { onConflict: 'farm_id' },
            )
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [currentFarm, zOffsetKey])
  const commitZOffset = async (s: string) => {
    const n = parseFloat(s)
    const next = Number.isFinite(n) ? n : 0
    setZOffset(next)
    setZOffsetInput(String(next))
    // localStorage (施工計画がフォールバック参照する) と DB 両方に反映
    if (zOffsetKey) {
      try { localStorage.setItem(zOffsetKey, String(next)) } catch { /* ignore */ }
    }
    if (currentFarm) {
      try {
        const { error } = await supabase
          .from('design_survey_calibration')
          .upsert(
            {
              farm_id: currentFarm.id,
              is_enabled: true,
              dz_offset: next,
            } as never,
            { onConflict: 'farm_id' },
          )
        if (error) {
          console.warn('[staking] Z補正の保存に失敗', error)
        }
      } catch (err) {
        console.warn('[staking] Z補正の保存に失敗', err)
      }
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
    const byRef = new Map<string, StakingRecord[]>()
    const standalone: StakingRecord[] = []
    for (const r of filtered) {
      if (r.targetType === 'coordinate' && r.targetRefId) {
        const arr = byRef.get(r.targetRefId) ?? []
        arr.push(r)
        byRef.set(r.targetRefId, arr)
      } else {
        standalone.push(r)
      }
    }
    // 各 グループ の 記録 は 古い 順 に ソート (m1 = 先に 測った、 m2 = 後に 測った)
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
    for (const r of standalone) {
      out.push({
        key: r.id,
        designName: r.targetName ?? '',
        designX: r.targetX,
        designY: r.targetY,
        designZ: r.targetZ,
        surveyCategory: r.surveyCategory,
        targetType: r.targetType,
        m1: r,
        m2: null,
      })
    }
    // 直近 が 先頭 (m1 の 記録日時 降順)
    out.sort((a, b) => {
      const at = a.m1?.recordedAt ?? ''
      const bt = b.m1?.recordedAt ?? ''
      return bt.localeCompare(at)
    })
    return out
  }, [filtered])

  // 平均誤差・件数の簡易サマリ
  const summary = useMemo(() => {
    let stakeCount = 0
    let freeCount = 0
    let sumDx2 = 0
    let pairs = 0
    for (const r of filtered) {
      if (r.targetType === 'free') freeCount++
      else stakeCount++
      if (r.targetX != null && r.targetY != null) {
        const dx = r.measuredX - r.targetX
        const dy = r.measuredY - r.targetY
        sumDx2 += dx * dx + dy * dy
        pairs++
      }
    }
    const rms = pairs > 0 ? Math.sqrt(sumDx2 / pairs) : null
    return { total: filtered.length, stake: stakeCount, free: freeCount, rms }
  }, [filtered])

  const handleDelete = async (id: string, name: string | null) => {
    if (!confirm(`記録「${name ?? '(無題)'}」を削除しますか？`)) return
    await deleteRecord(id)
  }

  // CSV 出力（実測値ベース）
  const handleExportCSV = () => {
    if (filtered.length === 0) return
    const header =
      '点名,測量種別,X(実測),Y(実測),Z(実測),Z(補正),X(計画),Y(計画),Z(計画),精度(m),サンプル数,記録日時\n'
    const rows = filtered
      .map((r) =>
        [
          r.targetName ?? '',
          CATEGORY_LABEL[r.surveyCategory],
          r.measuredX.toFixed(3),
          r.measuredY.toFixed(3),
          r.measuredZ != null ? r.measuredZ.toFixed(3) : '',
          r.measuredZ != null ? (r.measuredZ + zOffset).toFixed(3) : '',
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
      const xStr = r.measuredX.toFixed(3).padStart(10, ' ')
      const yStr = r.measuredY.toFixed(3).padStart(10, ' ')
      const zStr =
        r.measuredZ != null ? r.measuredZ.toFixed(3).padStart(10, ' ') : ''
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
    <div className="h-full flex flex-col">
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

        <div className="ml-auto flex items-center gap-2">
          {/* Z 補正: 実測値に加算する定数オフセット */}
          <label
            className="flex items-center gap-1 text-xs"
            title="実測値 Z にこの値 (m) を加算した「補正 Z」を表示。GPS 系統差を素早く吸収するための簡易補正"
          >
            <span className="text-slate-500">Z補正</span>
            <input
              type="number"
              step={0.001}
              value={zOffsetInput}
              onChange={(e) => setZOffsetInput(e.target.value)}
              onBlur={(e) => void commitZOffset(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="w-20 px-1.5 py-0.5 border rounded text-right font-mono"
            />
            <span className="text-slate-500">m</span>
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

      {/* サマリ */}
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-4 text-xs text-slate-600">
        <span>合計 <span className="font-semibold">{summary.total}</span> 件</span>
        <span>測設 <span className="font-semibold">{summary.stake}</span> / フリー <span className="font-semibold">{summary.free}</span></span>
        {summary.rms != null && (
          <span>
            計画値からの RMS: <span className="font-mono font-semibold">{summary.rms.toFixed(3)}</span> m
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
          checkedCoordIds={linkedCoordIds}
          onPointSelect={handleCoordSelectOnMap}
        >
          {/* 行 選択時 の 地図 pan/zoom */}
          <RecordZoomController target={zoomTarget} />
          {measuredPointsForMap.map((m) => {
            // リンク 済み: 対応する 設計座標 との 間に 誤差ベクトル 線 を 引く。
            const linkedCoord =
              m.record.targetType === 'coordinate' && m.record.targetRefId
                ? coordinates.find((c) => c.id === m.record.targetRefId)
                : null
            const linkedLL = linkedCoord
              ? converter.toLatLng(linkedCoord.x, linkedCoord.y)
              : null
            return (
              <div key={`meas-${m.id}`}>
                {linkedLL && (
                  <Polyline
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
                )}
                <CircleMarker
                  center={[m.lat, m.lng]}
                  radius={selectedRecordId === m.id ? 7 : 4}
                  eventHandlers={{
                    click: () => handleRowClick(m.id),
                  }}
                  pathOptions={{
                    color: selectedRecordId === m.id ? '#1d4ed8' : '#fff',
                    fillColor: m.record.surveyCategory === 'asbuilt' ? '#10b981' : '#f97316',
                    fillOpacity: 0.9,
                    weight: selectedRecordId === m.id ? 2.5 : 1.5,
                  }}
                >
                  <Tooltip
                    permanent
                    direction="right"
                    offset={[6, 0]}
                    className="point-label-tooltip"
                  >
                    <span
                      style={{
                        color: m.record.surveyCategory === 'asbuilt' ? '#10b981' : '#f97316',
                        textShadow:
                          '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                      }}
                    >
                      {m.record.targetName ?? '(実測)'}
                    </span>
                  </Tooltip>
                </CircleMarker>
              </div>
            )
          })}
        </CoordinateMap>
      </div>

      {/* 下半分: テーブル (isolate で テーブル 内 の sticky thead の z-index が
          地図側 と 干渉 しない ように 独立 スタッキング コンテキスト を 作る) */}
      <div className="flex-1 min-h-0 overflow-auto bg-white isolate">
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
          <table className="w-full text-xs border-collapse">
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
                  colSpan={3}
                  title="1 回目 の 実測"
                >
                  実測1
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-orange-50"
                  colSpan={3}
                  title="2 回目 の 実測 (無い 場合 は — )"
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
                  title="実測1 と 実測2 の 平均 (実測2 が 無ければ 実測1)"
                >
                  平均
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-blue-50"
                  colSpan={3}
                  title="設計 と 平均 の 差 (平均 - 設計)。 水平 = √(dX²+dY²)"
                >
                  平均 - 設計
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
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">X</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Y</th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">Z</th>
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
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">水平</th>
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
                // 平均 - 設計
                const dvsX = avgX != null && g.designX != null ? avgX - g.designX : null
                const dvsY = avgY != null && g.designY != null ? avgY - g.designY : null
                const dvsH = dvsX != null && dvsY != null ? Math.hypot(dvsX, dvsY) : null
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
                    {/* 実測1 (X/Y/Z) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1?.measuredZ != null ? (m1.measuredZ + zOffset).toFixed(3) : '—'}
                    </td>
                    {/* 実測2 (X/Y/Z) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2?.measuredZ != null ? (m2.measuredZ + zOffset).toFixed(3) : '—'}
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
                      {avgZ != null ? (avgZ + zOffset).toFixed(3) : '—'}
                    </td>
                    {/* 平均 - 設計 */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsX != null ? dvsX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsY != null ? dvsY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                      {dvsH != null ? dvsH.toFixed(3) : '—'}
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
    </div>
  )
}
