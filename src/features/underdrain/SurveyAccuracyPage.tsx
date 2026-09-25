// 実測記録 > 座標比較表。
//
// 当初 の 座標 と 実測記録 を ユーザ が 明示 的 に 選択 して 取り込む。
// 選択 前 は 空 状態 の プレースホルダ を 表示 し、「取り込み設定」 で
// モーダル を 開き 2 列 (当初 / 実測) の チェックリスト で 対象 を 決める。
//
// 集計 式 は 従来 と 同じ (deriveRow 共有)。「補正」 系 は 割愛。

import { useEffect, useMemo, useState } from 'react'
import { Loader2, ClipboardCheck, X, Plus } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  useStakingStore,
  type StakingRecord,
  type SurveyCategory,
} from '@/stores/stakingStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { deriveRow, groupStakingRecords, type StakingGroup } from '@/lib/stakingGroups'
import {
  setLabel,
  useSurveySetStore,
  type SurveyRecordSet,
} from '@/stores/surveySetStore'

const CATEGORY_LABEL: Record<SurveyCategory, string> = {
  initial: '起工',
  asbuilt: '出来形',
}

export function SurveyAccuracyPage() {
  const { currentFarm } = useFarmStore()
  const records = useStakingStore((s) => s.records)
  const fetchRecords = useStakingStore((s) => s.fetchRecords)
  const loading = useStakingStore((s) => s.loading)
  const coordinates = useCoordinateStore((s) => s.coordinates)
  const fetchCoordinates = useCoordinateStore((s) => s.fetchCoordinates)
  const sets = useSurveySetStore((st) => st.sets)
  const fetchSets = useSurveySetStore((st) => st.fetchByFarm)

  const [filter, setFilter] = useState<'all' | SurveyCategory>('all')
  const [showZ, setShowZ] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 選択済み: 空 = 未取込 (テーブル は 表示 しない)
  const [selectedDesignIds, setSelectedDesignIds] = useState<Set<string>>(new Set())
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (currentFarm?.id) {
      void fetchRecords(currentFarm.id)
      void fetchSets(currentFarm.id)
      void fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm?.id, fetchRecords, fetchSets, fetchCoordinates])

  // 工区 が 変わったら 選択 を リセット (前工区 の id が 残ら ない よう に)
  useEffect(() => {
    setSelectedDesignIds(new Set())
    setSelectedRecordIds(new Set())
  }, [currentFarm?.id])

  // 当初 の 選択 に 連動 して 対象 の 実測記録 を 抽出
  const filteredRecords = useMemo(() => {
    if (!currentFarm?.id) return []
    return records.filter(
      (r) => r.farmId === currentFarm.id && selectedRecordIds.has(r.id),
    )
  }, [records, selectedRecordIds, currentFarm?.id])

  const grouped = useMemo<StakingGroup[]>(() => {
    const raw = groupStakingRecords(filteredRecords)
    // 当初 の 選択 で 座標 タイプ の 行 を 絞る (free / pipe_vertex は そのまま)
    if (selectedDesignIds.size === 0) return raw
    return raw.filter((g) => {
      if (g.targetType !== 'coordinate') return true
      const refId = g.m1?.targetRefId ?? null
      return refId != null && selectedDesignIds.has(refId)
    })
  }, [filteredRecords, selectedDesignIds])

  const filteredGrouped = useMemo(() => {
    if (filter === 'all') return grouped
    return grouped.filter((g) => g.surveyCategory === filter)
  }, [grouped, filter])

  const rows = useMemo(
    () =>
      filteredGrouped.map((g) => ({
        g,
        d: deriveRow(g, 0, 0, 0),
      })),
    [filteredGrouped],
  )

  const hasSelection = selectedDesignIds.size > 0 || selectedRecordIds.size > 0

  const clearSelection = () => {
    setSelectedDesignIds(new Set())
    setSelectedRecordIds(new Set())
  }

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
      <div className="px-4 py-3 border-b bg-white flex items-center gap-2 flex-wrap">
        <ClipboardCheck className="h-4 w-4 text-slate-500" />
        <span className="font-medium">座標比較表</span>
        <span className="text-xs text-slate-500">{currentFarm.name}</span>
        <div className="ml-4 flex items-center gap-1 text-xs">
          {(['all', 'initial', 'asbuilt'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-2 py-0.5 rounded border ${
                filter === c
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {c === 'all' ? 'すべて' : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <label className="ml-4 flex items-center gap-1 text-[11px] text-slate-500">
          <input
            type="checkbox"
            checked={showZ}
            onChange={(e) => setShowZ(e.target.checked)}
          />
          Z 列 を 表示
        </label>
        <div className="ml-auto flex items-center gap-2">
          {hasSelection && (
            <>
              <span className="text-[11px] text-slate-500">
                当初 {selectedDesignIds.size} / 実測 {selectedRecordIds.size}
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="text-[11px] text-slate-500 hover:text-slate-700 underline"
              >
                クリア
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            取り込み設定
          </button>
        </div>
      </div>

      {/* テーブル / 空状態 */}
      <div className="flex-1 min-h-0 overflow-auto bg-white isolate">
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : !hasSelection ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 text-sm gap-3 px-4">
            <ClipboardCheck className="h-8 w-8 text-slate-300" />
            <div className="text-center">
              比較 する 当初 と 実測記録 を 選んで 取り込みます。
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              取り込み設定 を 開く
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            条件 に 一致 する 行 が ありません
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
                <th
                  className="px-2 py-1 border-b border-r text-center bg-blue-50"
                  colSpan={showZ ? 4 : 3}
                  title="実測平均 - 当初 の 生値。 水平 = √(dX²+dY²)"
                >
                  実測平均 - 当初
                </th>
                <th className="px-2 py-2 border-b text-right" rowSpan={2}>
                  精度(m)
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
                      <span className="ml-1 text-slate-400">
                        {CATEGORY_LABEL[g.surveyCategory]}
                      </span>
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
                    {/* 実測平均 - 当初 */}
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
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {pickerOpen && (
        <ImportPickerModal
          farmId={currentFarm.id}
          coordinates={coordinates}
          records={records.filter((r) => r.farmId === currentFarm.id)}
          sets={sets}
          initialDesignIds={selectedDesignIds}
          initialRecordIds={selectedRecordIds}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(dIds, rIds) => {
            setSelectedDesignIds(dIds)
            setSelectedRecordIds(rIds)
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ---- Import picker modal ---------------------------------------------------

type DesignCoord = {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
}

function ImportPickerModal({
  coordinates,
  records,
  sets,
  initialDesignIds,
  initialRecordIds,
  onCancel,
  onConfirm,
}: {
  farmId: string
  coordinates: DesignCoord[]
  records: StakingRecord[]
  sets: SurveyRecordSet[]
  initialDesignIds: Set<string>
  initialRecordIds: Set<string>
  onCancel: () => void
  onConfirm: (designIds: Set<string>, recordIds: Set<string>) => void
}) {
  const [designIds, setDesignIds] = useState<Set<string>>(new Set(initialDesignIds))
  const [recordIds, setRecordIds] = useState<Set<string>>(new Set(initialRecordIds))
  const [designQuery, setDesignQuery] = useState('')
  const [recordQuery, setRecordQuery] = useState('')

  const filteredDesigns = useMemo(() => {
    const q = designQuery.trim().toLowerCase()
    const list = q
      ? coordinates.filter((c) => c.pointNumber.toLowerCase().includes(q))
      : coordinates
    return [...list].sort((a, b) => a.pointNumber.localeCompare(b.pointNumber))
  }, [coordinates, designQuery])

  const recordsBySet = useMemo(() => {
    const q = recordQuery.trim().toLowerCase()
    const filtered = q
      ? records.filter((r) =>
          (r.targetName ?? '').toLowerCase().includes(q),
        )
      : records
    const m = new Map<string | null, StakingRecord[]>()
    for (const r of filtered) {
      const key = r.recordSetId ?? null
      const arr = m.get(key) ?? []
      arr.push(r)
      m.set(key, arr)
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    }
    return m
  }, [records, recordQuery])

  const toggleId = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const setAllDesigns = (on: boolean) => {
    if (on) setDesignIds(new Set(filteredDesigns.map((c) => c.id)))
    else setDesignIds(new Set())
  }

  const setAllRecords = (on: boolean) => {
    if (on) {
      const all = new Set<string>()
      for (const arr of recordsBySet.values()) for (const r of arr) all.add(r.id)
      setRecordIds(all)
    } else setRecordIds(new Set())
  }

  const toggleSet = (setId: string | null, on: boolean) => {
    const arr = recordsBySet.get(setId) ?? []
    const next = new Set(recordIds)
    for (const r of arr) {
      if (on) next.add(r.id)
      else next.delete(r.id)
    }
    setRecordIds(next)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="font-medium">取り込み設定</div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 divide-x">
          {/* 当初 */}
          <div className="flex flex-col min-h-0">
            <div className="px-3 py-2 border-b bg-slate-50 flex items-center gap-2 text-xs">
              <span className="font-medium text-slate-700">当初 座標</span>
              <span className="text-slate-500">
                {designIds.size} / {coordinates.length}
              </span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setAllDesigns(true)}
                  className="px-1.5 py-0.5 rounded border text-[11px] hover:bg-white"
                >
                  すべて選択
                </button>
                <button
                  type="button"
                  onClick={() => setAllDesigns(false)}
                  className="px-1.5 py-0.5 rounded border text-[11px] hover:bg-white"
                >
                  解除
                </button>
              </div>
            </div>
            <div className="px-3 py-2 border-b">
              <input
                type="text"
                value={designQuery}
                onChange={(e) => setDesignQuery(e.target.value)}
                placeholder="点番号 で 絞込"
                className="w-full text-xs border rounded px-2 py-1"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {filteredDesigns.length === 0 ? (
                <div className="p-4 text-xs text-slate-400 text-center">
                  当初 座標 が ありません
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredDesigns.map((c) => {
                    const on = designIds.has(c.id)
                    return (
                      <li key={c.id}>
                        <label
                          className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-blue-50/40 ${
                            on ? 'bg-blue-50/60' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setDesignIds(toggleId(designIds, c.id))}
                          />
                          <span className="font-medium truncate">
                            {c.pointNumber}
                          </span>
                          <span className="ml-auto font-mono text-slate-500">
                            {c.x.toFixed(3)}, {c.y.toFixed(3)}
                            {c.z != null ? `, ${c.z.toFixed(3)}` : ''}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* 実測記録 */}
          <div className="flex flex-col min-h-0">
            <div className="px-3 py-2 border-b bg-slate-50 flex items-center gap-2 text-xs">
              <span className="font-medium text-slate-700">実測記録</span>
              <span className="text-slate-500">
                {recordIds.size} / {records.length}
              </span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setAllRecords(true)}
                  className="px-1.5 py-0.5 rounded border text-[11px] hover:bg-white"
                >
                  すべて選択
                </button>
                <button
                  type="button"
                  onClick={() => setAllRecords(false)}
                  className="px-1.5 py-0.5 rounded border text-[11px] hover:bg-white"
                >
                  解除
                </button>
              </div>
            </div>
            <div className="px-3 py-2 border-b">
              <input
                type="text"
                value={recordQuery}
                onChange={(e) => setRecordQuery(e.target.value)}
                placeholder="点名 で 絞込"
                className="w-full text-xs border rounded px-2 py-1"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {recordsBySet.size === 0 ? (
                <div className="p-4 text-xs text-slate-400 text-center">
                  実測 記録 が ありません
                </div>
              ) : (
                <div>
                  {[
                    ...sets
                      .filter((st) => recordsBySet.has(st.id))
                      .map((st) => ({
                        key: st.id as string | null,
                        label: setLabel(st),
                        arr: recordsBySet.get(st.id) ?? [],
                      })),
                    ...(recordsBySet.has(null)
                      ? [
                          {
                            key: null as string | null,
                            label: '未振り分け',
                            arr: recordsBySet.get(null) ?? [],
                          },
                        ]
                      : []),
                  ].map(({ key, label, arr }) => {
                    const allOn = arr.every((r) => recordIds.has(r.id))
                    return (
                      <div key={key ?? '__none__'} className="border-b">
                        <div className="px-3 py-1.5 bg-slate-50 flex items-center gap-2 text-[11px] text-slate-600">
                          <input
                            type="checkbox"
                            checked={allOn}
                            onChange={(e) => toggleSet(key, e.target.checked)}
                          />
                          <span className="font-medium truncate">{label}</span>
                          <span className="ml-auto text-slate-400">
                            {arr.filter((r) => recordIds.has(r.id)).length} / {arr.length}
                          </span>
                        </div>
                        <ul className="divide-y">
                          {arr.map((r) => {
                            const on = recordIds.has(r.id)
                            return (
                              <li key={r.id}>
                                <label
                                  className={`flex items-center gap-2 pl-8 pr-3 py-1 text-xs cursor-pointer hover:bg-blue-50/40 ${
                                    on ? 'bg-blue-50/60' : ''
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() =>
                                      setRecordIds(toggleId(recordIds, r.id))
                                    }
                                  />
                                  <span className="truncate">
                                    {r.targetName ?? '(無題)'}
                                  </span>
                                  <span className="ml-auto font-mono text-slate-500">
                                    {r.measuredX.toFixed(3)}, {r.measuredY.toFixed(3)}
                                  </span>
                                  <span className="text-[10px] text-slate-400 whitespace-nowrap">
                                    {r.recordedAt.slice(0, 16).replace('T', ' ')}
                                  </span>
                                </label>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border text-xs hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm(designIds, recordIds)}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
          >
            取り込む
          </button>
        </div>
      </div>
    </div>
  )
}
