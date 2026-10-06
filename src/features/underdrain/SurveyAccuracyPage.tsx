// 実測記録 > 座標比較表。
//
// 「比較ビュー」 (= 当初 として 使う 点 の セット) を タブ で 管理 する。
//   - タブ は 工区 ごと に localStorage に 永続化
//   - 各 タブ の 当初 点 は 2 通り で 取り込める:
//       (a) 測設計画 の 保管ルート から コピー
//       (b) 地図 上 の 点 を クリック で トグル
//   - タブ は × で 削除 でき、「+ 新規」 で 空 タブ を 追加
//   - 右側 に 地図 を 配置 し、 クリック 選択 と 現在 の 当初 の 可視化 を 兼ねる

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, ClipboardCheck, Plus, X } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore } from '@/stores/stakingStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { deriveRow, type StakingGroup } from '@/lib/stakingGroups'
import { useExportRouteStore } from '@/stores/exportRouteStore'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { ResizableSplit } from '@/components/layout/ResizableSplit'

/** 比較モード: 'pair' = 当初 + 実測1 + 実測2 の 平均比較、 'single' = 当初 + 実測1 のみ */
type CompareMode = 'single' | 'pair'

interface ComparisonView {
  id: string
  name: string
  coordIds: string[]
  /** 旧 データ (type 無し) は 'pair' 扱い */
  type?: CompareMode
  /** Z 座標 も 比較 する か (旧 データ 無し は true として 従来 挙動 を 保つ) */
  hasZ?: boolean
}

const VIEWS_STORAGE_PREFIX = 'nc:surveyAccuracy:views:'

function loadViews(farmId: string): ComparisonView[] {
  try {
    const raw = localStorage.getItem(VIEWS_STORAGE_PREFIX + farmId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is ComparisonView =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as ComparisonView).id === 'string' &&
        typeof (v as ComparisonView).name === 'string' &&
        Array.isArray((v as ComparisonView).coordIds),
    )
  } catch {
    return []
  }
}

function saveViews(farmId: string, views: ComparisonView[]) {
  try {
    localStorage.setItem(VIEWS_STORAGE_PREFIX + farmId, JSON.stringify(views))
  } catch {
    /* 容量 不足 等 は 無視 */
  }
}

// 起工/出来形 の カテゴリ は 撤去 のため CATEGORY_LABEL は 削除。

export function SurveyAccuracyPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const records = useStakingStore((s) => s.records)
  const fetchRecords = useStakingStore((s) => s.fetchRecords)
  const loading = useStakingStore((s) => s.loading)
  const coordinates = useCoordinateStore((s) => s.coordinates)
  const fetchCoordinates = useCoordinateStore((s) => s.fetchCoordinates)
  // 測設計画 の 保管ルート (当初 の 取り込み元 の 1 つ)
  const routesByFarmId = useExportRouteStore((s) => s.routesByFarmId)
  const savedRoutes = useMemo(
    () => (currentFarm ? routesByFarmId.get(currentFarm.id) ?? [] : []),
    [routesByFarmId, currentFarm],
  )
  const fetchSavedRoutes = useExportRouteStore((s) => s.fetchRoutes)

  const [views, setViews] = useState<ComparisonView[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  // 「測設計画 から 取り込む」 select の 現在値 (per tab にはしない。 都度 選び 直す)
  const [importRouteId, setImportRouteId] = useState<string>('')
  // 「座標比較表作成」 ダイアログ の 開閉 + 入力中 の 設定
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newViewType, setNewViewType] = useState<CompareMode>('pair')
  const [newViewHasZ, setNewViewHasZ] = useState(true)

  useEffect(() => {
    if (currentFarm?.id) {
      void fetchRecords(currentFarm.id)
      void fetchCoordinates(currentFarm.id)
      void fetchSavedRoutes(currentFarm.id)
      const project = projects.find((p) => p.id === currentFarm.project_id)
      if (project) {
        const { setZone } = useCoordinateStore.getState()
        setZone(project.coordinate_zone)
      }
    }
  }, [currentFarm?.id, projects, fetchRecords, fetchCoordinates, fetchSavedRoutes, currentFarm])

  // 工区 が 変わったら views を 読み直し、 選択中 を クリア
  useEffect(() => {
    if (!currentFarm?.id) {
      setViews([])
      setActiveViewId(null)
      return
    }
    const loaded = loadViews(currentFarm.id)
    setViews(loaded)
    setActiveViewId(null)
    setImportRouteId('')
  }, [currentFarm?.id])

  // views を 変える 度 に localStorage へ 永続化
  useEffect(() => {
    if (!currentFarm?.id) return
    saveViews(currentFarm.id, views)
  }, [views, currentFarm?.id])

  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) ?? null,
    [views, activeViewId],
  )

  const addView = useCallback(
    (type: CompareMode, hasZ: boolean) => {
      const id = (crypto.randomUUID?.() ?? Date.now().toString()) as string
      const n = views.length + 1
      const label = type === 'single' ? `1点比較 ${n}` : `2点平均 ${n}`
      const newView: ComparisonView = { id, name: label, coordIds: [], type, hasZ }
      setViews((prev) => [...prev, newView])
      setActiveViewId(id)
    },
    [views],
  )

  const deleteView = useCallback(
    (id: string) => {
      const v = views.find((x) => x.id === id)
      if (!v) return
      if (!confirm(`タブ 「${v.name}」 を 削除 します か？`)) return
      setViews((prev) => prev.filter((x) => x.id !== id))
      if (activeViewId === id) setActiveViewId(null)
    },
    [views, activeViewId],
  )

  const renameView = useCallback((id: string, name: string) => {
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, name } : v)))
  }, [])

  const updateActiveViewCoords = useCallback(
    (updater: (prev: string[]) => string[]) => {
      if (!activeViewId) return
      setViews((prev) =>
        prev.map((v) =>
          v.id === activeViewId ? { ...v, coordIds: updater(v.coordIds) } : v,
        ),
      )
    },
    [activeViewId],
  )

  // 地図 の 点 を クリック した 時: 当初 セット に トグル
  const handleMapPointSelect = useCallback(
    (id: string) => {
      updateActiveViewCoords((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      )
    },
    [updateActiveViewCoords],
  )

  // 当初 の id 集合 (地図 の ハイライト と 表 の 絞込 に 使う)
  const activeDesignIds = useMemo(
    () => new Set(activeView?.coordIds ?? []),
    [activeView],
  )

  const filteredRecords = useMemo(() => {
    if (!currentFarm?.id) return []
    return records.filter((r) => r.farmId === currentFarm.id)
  }, [records, currentFarm?.id])

  const compareMode: CompareMode = activeView?.type ?? 'pair'
  // Z の 表示 は 選択中 タブ の 設定。 旧 データ (hasZ 未設定) は true 既定 で 従来 挙動 を 保つ
  const showZ: boolean = activeView?.hasZ ?? true

  // 当初 が 1 点 も 指定 されて いない 場合 は 行 を 出さない。
  // 当初 が ある 場合:
  //   1. 実測記録 が 存在 する 当初 → 通常 の グループ 行 (coordinate 型 のみ)
  //      - 'pair' は 2 点 ペア、 'single' は 1 点 1 行 (m2 は null)
  //   2. 実測 が 無い 当初 → 「未測」 行 を 合成 (m1/m2 null、 当初 X/Y/Z は 座標管理 から)
  // フリー 点 / pipe_vertex は 「当初」 に 載ら ない の で 除外。
  const grouped = useMemo<StakingGroup[]>(() => {
    if (activeDesignIds.size === 0) return []
    // 対象 の 実測記録 を 当初 ID で グループ 化
    const byRef = new Map<string, typeof filteredRecords>()
    for (const r of filteredRecords) {
      if (r.targetType !== 'coordinate') continue
      if (!r.targetRefId || !activeDesignIds.has(r.targetRefId)) continue
      const arr = byRef.get(r.targetRefId) ?? []
      arr.push(r)
      byRef.set(r.targetRefId, arr)
    }
    const coordById = new Map(coordinates.map((c) => [c.id, c]))
    const matched: StakingGroup[] = []
    for (const [refId, arr] of byRef.entries()) {
      arr.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      if (compareMode === 'single') {
        // 1 行 = 1 記録
        arr.forEach((r, i) => {
          matched.push({
            key: i === 0 ? refId : `${refId}#${i}`,
            designName: r.targetName ?? '',
            designX: r.targetX,
            designY: r.targetY,
            designZ: r.targetZ,
            surveyCategory: r.surveyCategory,
            targetType: 'coordinate',
            m1: r,
            m2: null,
          })
        })
      } else {
        // 2 点 ペア
        for (let i = 0; i < arr.length; i += 2) {
          matched.push({
            key: i === 0 ? refId : `${refId}#${i}`,
            designName: arr[i].targetName ?? '',
            designX: arr[i].targetX,
            designY: arr[i].targetY,
            designZ: arr[i].targetZ,
            surveyCategory: arr[i].surveyCategory,
            targetType: 'coordinate',
            m1: arr[i],
            m2: arr[i + 1] ?? null,
          })
        }
      }
    }
    const measuredRefIds = new Set(byRef.keys())
    const unmeasured: StakingGroup[] = []
    for (const id of activeDesignIds) {
      if (measuredRefIds.has(id)) continue
      const c = coordById.get(id)
      if (!c) continue
      unmeasured.push({
        key: `unmeasured-${id}`,
        designName: c.pointNumber,
        designX: c.x,
        designY: c.y,
        designZ: c.z,
        surveyCategory: 'initial',
        targetType: 'coordinate',
        m1: null,
        m2: null,
      })
    }
    return [...matched, ...unmeasured].sort((a, b) =>
      a.designName.localeCompare(b.designName, 'ja'),
    )
  }, [filteredRecords, activeDesignIds, coordinates, compareMode])

  const rows = useMemo(
    () =>
      grouped.map((g) => ({
        g,
        d: deriveRow(g, 0, 0, 0),
      })),
    [grouped],
  )

  const hasSelection = activeViewId !== null

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="px-4 py-2 border-b bg-white flex items-center gap-2 flex-wrap">
        <ClipboardCheck className="h-4 w-4 text-slate-500" />
        <span className="font-medium">座標比較表</span>
        <span className="text-xs text-slate-500">{currentFarm.name}</span>
        {/* Z 列 を 表示: 選択中 タブ の hasZ を 編集 */}
        <label
          className={`ml-4 flex items-center gap-1 text-[11px] ${
            activeView ? 'text-slate-700' : 'text-slate-400'
          }`}
        >
          <input
            type="checkbox"
            checked={showZ}
            disabled={!activeView}
            onChange={(e) => {
              if (!activeView) return
              setViews((prev) =>
                prev.map((v) => (v.id === activeView.id ? { ...v, hasZ: e.target.checked } : v)),
              )
            }}
          />
          Z 列 を 表示
        </label>
        <button
          type="button"
          onClick={() => {
            setNewViewType('pair')
            setNewViewHasZ(true)
            setCreateDialogOpen(true)
          }}
          className="inline-flex items-center gap-1 px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
        >
          <Plus className="h-3 w-3" />
          座標比較表作成
        </button>
        {hasSelection && (
          <span className="ml-auto text-[11px] text-slate-500">
            当初 {activeDesignIds.size} 点
          </span>
        )}
      </div>

      {/* 比較ビュー の タブ。 × で 削除、「+」 で 新規。 選択中 は 青下線 で 強調。 */}
      <div className="px-3 pt-1.5 border-b bg-slate-100 flex items-end gap-1 overflow-x-auto">
        {views.map((v) => {
          const on = activeViewId === v.id
          return (
            <div
              key={v.id}
              className={`-mb-px inline-flex items-center rounded-t border border-b-0 whitespace-nowrap ${
                on
                  ? 'bg-white border-slate-300 border-b-2 border-b-blue-600'
                  : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveViewId(v.id)}
                className={`px-3 py-1.5 text-xs whitespace-nowrap ${
                  on ? 'text-blue-700 font-medium' : 'text-slate-600'
                }`}
              >
                {v.name}
                <span className="ml-1 text-slate-400">{v.coordIds.length}</span>
              </button>
              <button
                type="button"
                onClick={() => deleteView(v.id)}
                title="このタブを削除"
                className="mr-1 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {/* タブ 作成 は ヘッダ の 「座標比較表作成」 ボタン に 集約 (2026-10) */}
      </div>

      {/* 本体: 左 = 表、 右 = 取り込み コントロール + 地図 */}
      <ResizableSplit
        storageKey="survey-accuracy"
        defaultLeft={720}
        minLeft={400}
        maxLeft={1600}
        className="flex-1 min-h-0"
        left={
          <div className="flex-1 min-h-0 overflow-auto bg-white isolate">
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : (
          <table className="min-w-max text-xs border-collapse whitespace-nowrap">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-slate-700">
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>
                  種別
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-slate-50"
                  colSpan={showZ ? 4 : 3}
                >
                  当初
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-orange-50"
                  colSpan={showZ ? 4 : 3}
                >
                  実測1
                </th>
                {compareMode === 'pair' && (
                  <>
                    <th
                      className="px-2 py-1 border-b border-r text-center bg-orange-50"
                      colSpan={showZ ? 4 : 3}
                    >
                      実測2
                    </th>
                    <th
                      className="px-2 py-1 border-b border-r text-center bg-rose-50"
                      colSpan={showZ ? 3 : 2}
                      title="実測1 と 実測2 の 差 (実測2 - 実測1)"
                    >
                      実測差
                    </th>
                    <th
                      className="px-2 py-1 border-b border-r text-center bg-emerald-50"
                      colSpan={showZ ? 3 : 2}
                    >
                      実測平均
                    </th>
                  </>
                )}
                <th
                  className="px-2 py-1 border-b border-r text-center bg-blue-50"
                  colSpan={showZ ? 4 : 3}
                  title={
                    compareMode === 'pair'
                      ? '実測平均 - 当初 の 生値。 水平 = √(dX²+dY²)'
                      : '実測 - 当初 の 生値。 水平 = √(dX²+dY²)'
                  }
                >
                  {compareMode === 'pair' ? '実測平均 - 当初' : '実測 - 当初'}
                </th>
                <th className="px-2 py-2 border-b text-right" rowSpan={2}>
                  精度(m)
                </th>
                <th className="px-2 py-2 border-b text-center w-8" rowSpan={2} title="行を削除">
                  削除
                </th>
              </tr>
              <tr className="text-slate-700 text-[11px]">
                {/* 当初 */}
                <th className="px-2 py-1 border-b border-r text-left">点名</th>
                <th className="px-2 py-1 border-b border-r text-right">X</th>
                <th className="px-2 py-1 border-b border-r text-right">Y</th>
                {showZ && (
                  <th className="px-2 py-1 border-b border-r text-right">Z</th>
                )}
                {/* 実測1 */}
                <th className="px-2 py-1 border-b border-r text-left bg-orange-50">
                  点名
                </th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                  X
                </th>
                <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                  Y
                </th>
                {showZ && (
                  <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                    Z
                  </th>
                )}
                {compareMode === 'pair' && (
                  <>
                    {/* 実測2 */}
                    <th className="px-2 py-1 border-b border-r text-left bg-orange-50">
                      点名
                    </th>
                    <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                      X
                    </th>
                    <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                      Y
                    </th>
                    {showZ && (
                      <th className="px-2 py-1 border-b border-r text-right bg-orange-50">
                        Z
                      </th>
                    )}
                    {/* 実測差 (実測2 - 実測1) */}
                    <th className="px-2 py-1 border-b border-r text-right bg-rose-50">
                      dX
                    </th>
                    <th className="px-2 py-1 border-b border-r text-right bg-rose-50">
                      dY
                    </th>
                    {showZ && (
                      <th className="px-2 py-1 border-b border-r text-right bg-rose-50">
                        dZ
                      </th>
                    )}
                    {/* 実測平均 */}
                    <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">
                      X
                    </th>
                    <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">
                      Y
                    </th>
                    {showZ && (
                      <th className="px-2 py-1 border-b border-r text-right bg-emerald-50">
                        Z
                      </th>
                    )}
                  </>
                )}
                {/* 実測平均 - 当初 */}
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">
                  dX
                </th>
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">
                  dY
                </th>
                {showZ && (
                  <th className="px-2 py-1 border-b border-r text-right bg-blue-50">
                    dZ
                  </th>
                )}
                <th className="px-2 py-1 border-b border-r text-right bg-blue-50">
                  水平
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ g, d }) => {
                const { m1, m2 } = g
                const designName =
                  g.targetType === 'coordinate' && g.designName
                    ? g.designName.replace(/^G2?_/, '')
                    : m1?.targetName ?? '(無題)'
                const kind =
                  g.targetType === 'free'
                    ? 'フリー'
                    : g.targetType === 'pipe_vertex'
                      ? '頂点'
                      : '座標'
                return (
                  <tr key={g.key} className="hover:bg-blue-50/40">
                    <td className="px-2 py-1 border-b border-r text-slate-600">
                      {kind}
                      {/* 起工/出来形 の 区分 表示 は 撤去 */}
                    </td>
                    {/* 当初 */}
                    <td className="px-2 py-1 border-b border-r truncate max-w-[8rem]">
                      {designName}
                    </td>
                    <td className="px-2 py-1 border-b border-r text-right font-mono">
                      {g.designX != null ? g.designX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1 border-b border-r text-right font-mono">
                      {g.designY != null ? g.designY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1 border-b border-r text-right font-mono">
                        {g.designZ != null ? g.designZ.toFixed(3) : '—'}
                      </td>
                    )}
                    {/* 実測1 */}
                    <td className="px-2 py-1 border-b border-r truncate max-w-[8rem] bg-orange-50/40">
                      {m1?.targetName ?? '—'}
                    </td>
                    <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                      {m1 ? m1.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                      {m1 ? m1.measuredY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                        {m1?.measuredZ != null ? m1.measuredZ.toFixed(3) : '—'}
                      </td>
                    )}
                    {compareMode === 'pair' && (
                      <>
                        {/* 実測2 */}
                        <td className="px-2 py-1 border-b border-r truncate max-w-[8rem] bg-orange-50/40">
                          {m2?.targetName ?? '—'}
                        </td>
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                          {m2 ? m2.measuredX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                          {m2 ? m2.measuredY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1 border-b border-r text-right font-mono bg-orange-50/40">
                            {m2?.measuredZ != null ? m2.measuredZ.toFixed(3) : '—'}
                          </td>
                        )}
                        {/* 実測差 (実測2 - 実測1) */}
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-rose-50/40">
                          {d.diffX != null ? d.diffX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-rose-50/40">
                          {d.diffY != null ? d.diffY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1 border-b border-r text-right font-mono bg-rose-50/40">
                            {d.diffZ != null ? d.diffZ.toFixed(3) : '—'}
                          </td>
                        )}
                        {/* 実測平均 */}
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-emerald-50/40">
                          {d.avgX != null ? d.avgX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1 border-b border-r text-right font-mono bg-emerald-50/40">
                          {d.avgY != null ? d.avgY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1 border-b border-r text-right font-mono bg-emerald-50/40">
                            {d.avgZ != null ? d.avgZ.toFixed(3) : '—'}
                          </td>
                        )}
                      </>
                    )}
                    {/* 実測平均 - 当初 (single でも 表示: 実測 - 当初 として) */}
                    <td className="px-2 py-1 border-b border-r text-right font-mono bg-blue-50/40">
                      {d.dvsX != null ? d.dvsX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1 border-b border-r text-right font-mono bg-blue-50/40">
                      {d.dvsY != null ? d.dvsY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1 border-b border-r text-right font-mono bg-blue-50/40">
                        {d.dvsZ != null ? d.dvsZ.toFixed(3) : '—'}
                      </td>
                    )}
                    <td className="px-2 py-1 border-b border-r text-right font-mono bg-blue-50/40">
                      {d.dvsH != null ? d.dvsH.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1 border-b text-right font-mono">
                      {d.acc != null ? d.acc.toFixed(3) : '—'}
                    </td>
                    <td className="px-1 py-1 border-b text-center">
                      {g.targetType === 'coordinate' && g.m1?.targetRefId ? (
                        <button
                          type="button"
                          onClick={() => {
                            const refId = g.m1?.targetRefId
                            if (!refId) return
                            updateActiveViewCoords((prev) => prev.filter((x) => x !== refId))
                          }}
                          title="この行の当初座標を削除"
                          className="p-0.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
        }
        right={
          <div className="flex-1 flex flex-col bg-slate-100 relative min-w-0">
            {/* 取り込み コントロール: 測設計画 の 順路 から 置換 で 流し込む。
                タブ 未選択 でも プルダウン は 開ける。 取り込み 時 に タブ が 無けれ ば 自動 作成 */}
            <div className="p-2 bg-white border-b flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500 shrink-0">測設計画から取り込む</span>
              <select
                value={importRouteId}
                onChange={(e) => setImportRouteId(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 text-xs border rounded bg-white"
              >
                <option value="">
                  {savedRoutes.length === 0 ? '保管ルートがありません' : '選択…'}
                </option>
                {savedRoutes.map((r) => {
                  const coordIdSet = new Set(coordinates.map((c) => c.id))
                  const avail = r.points.filter((p) => coordIdSet.has(p.id)).length
                  return (
                    <option key={r.id} value={r.id}>
                      {r.name} ({avail}点)
                    </option>
                  )
                })}
              </select>
              <button
                type="button"
                disabled={!importRouteId}
                onClick={() => {
                  // アクティブ タブ が 無けれ ば 新規 作成 し、 その 直後 に 取り込む
                  const route = savedRoutes.find((r) => r.id === importRouteId)
                  if (!route) return
                  const coordIdSet = new Set(coordinates.map((c) => c.id))
                  const ids = route.points.filter((p) => coordIdSet.has(p.id)).map((p) => p.id)
                  if (!activeViewId) {
                    const newId = (crypto.randomUUID?.() ?? Date.now().toString()) as string
                    // 新規 作成 時 は 既定 で 2点平均 + Z 比較 ON
                    setViews((prev) => [
                      ...prev,
                      { id: newId, name: route.name, coordIds: ids, type: 'pair', hasZ: true },
                    ])
                    setActiveViewId(newId)
                  } else {
                    updateActiveViewCoords(() => ids)
                  }
                  setImportRouteId('')
                }}
                className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                title="選択した順路の点で当初を置き換えます (タブが無ければ自動作成)"
              >
                取り込む
              </button>
            </div>
            {activeViewId && activeView && (
              <div className="px-2 py-1 bg-emerald-50 border-b text-[11px] text-emerald-800 flex items-center gap-2">
                <input
                  type="text"
                  value={activeView.name}
                  onChange={(e) => renameView(activeView.id, e.target.value)}
                  className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border rounded bg-white"
                />
                <span className="shrink-0">
                  地図で点をクリックして追加 / 削除 (当初 {activeView.coordIds.length} 点)
                </span>
              </div>
            )}
            <div className="flex-1 min-h-0">
              <CoordinateMap
                key={currentFarm.id}
                farmId={currentFarm.id}
                showOrtho
                orangeCoordIds={activeDesignIds}
                coordinatesInteractive={!!activeViewId}
                onPointSelect={activeViewId ? handleMapPointSelect : undefined}
              />
            </div>
          </div>
        }
      />

      {/* 「座標比較表作成」 ダイアログ: 計測タイプ + Z 比較 を 選び、 タブ を 作成 */}
      {createDialogOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setCreateDialogOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b font-medium">座標比較表を作成</div>
            <div className="px-4 py-3 space-y-3 text-sm">
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1.5">計測タイプ</div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={newViewType === 'single'}
                    onChange={() => setNewViewType('single')}
                  />
                  <span>1 回計測 (当初 + 実測1)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <input
                    type="radio"
                    checked={newViewType === 'pair'}
                    onChange={() => setNewViewType('pair')}
                  />
                  <span>2 回計測 (当初 + 実測1 + 実測2 の 平均比較)</span>
                </label>
              </div>
              <div className="pt-2 border-t">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newViewHasZ}
                    onChange={(e) => setNewViewHasZ(e.target.checked)}
                  />
                  <span>Z 座標 も 比較する</span>
                </label>
              </div>
            </div>
            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateDialogOpen(false)}
                className="px-3 py-1.5 text-xs border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => {
                  addView(newViewType, newViewHasZ)
                  setCreateDialogOpen(false)
                }}
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                作成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

