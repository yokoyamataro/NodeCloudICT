// 地籍測量: 地積測量図作成ページ。
//
// doc/地積測量図3.tif が 実物。 B4 1 枚 に 左 が 計算書 (与点 の 成果 と
// 求積表)、右 が 図。 1 工区 に 複数枚 作る ので 「左 に 図面 の 一覧 /
// 右 に 編集」 の 形 に する。 編集 は 作成 の 順序 そのまま の 4 段:
//   1 図面情報 → 2 対象地番 → 3 基準点 → 4 図枠
//
// 作製者 / 申請人 / 図枠 の 手直し / 出力 は 建物図面 の 部品 を 使い回す。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Loader2, Plus, Ruler, Trash2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { useLandDrawStore, type LandDrawPatch } from '@/stores/landDrawStore'
import type { ParcelOption } from './floorPlanTypes'
import { calcParcelArea, n2, type LandSurveyDrawing } from './landDrawTypes'
import type { ControlPointForDraw } from './landDrawSheet'
import { LandStepControls, LandStepFrame, LandStepParcels } from './LandDrawSteps'

const STEPS = [
  { key: 1, label: '対象地番', hint: '地番・境界標・表題' },
  { key: 2, label: '基準点', hint: '与点の成果' },
  { key: 3, label: '図枠', hint: '縮尺と出力' },
] as const

function planTitle(p: LandSurveyDrawing): string {
  if (p.title && p.title.trim() !== '') return p.title
  if (p.location) return p.location
  return '（無題の図面）'
}

export function LandSurveyDrawingPage() {
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null

  const {
    drawings,
    loading,
    saving,
    error,
    fetchByFarm,
    createDrawing,
    duplicateDrawing,
    updateDrawing,
    deleteDrawing,
  } = useLandDrawStore()
  const { getWorkAreasByType, fetchWorkAreas } = useWorkAreaStore()
  const { byWorkAreaId, fetchByWorkAreaIds } = useParcelStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)

  const zone = useMemo(
    () => projects.find((p) => p.id === currentFarm?.project_id)?.coordinate_zone ?? 13,
    [projects, currentFarm],
  )
  // 地図 に 出す とき に 平面直角 → 緯度経度 へ 直す
  const conv = useMemo(() => new CoordinateConverter(zone), [zone])

  // 境界標 の 表 を 作る ため の 杭種 と 設置状態
  const stakeById = useMemo(
    () =>
      new Map(
        coordinates.map((c) => [c.id, { stakeType: c.stakeType, stakeStatus: c.stakeStatus }]),
      ),
    [coordinates],
  )

  useEffect(() => {
    if (farmId) {
      void fetchByFarm(farmId)
      void fetchWorkAreas(farmId)
      void fetchCoordinates(farmId)
    }
  }, [farmId, fetchByFarm, fetchWorkAreas, fetchCoordinates])

  const workAreas = getWorkAreasByType('boundary_survey')
  useEffect(() => {
    if (workAreas.length > 0) void fetchByWorkAreaIds(workAreas.map((w) => w.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, workAreas.length, fetchByWorkAreaIds])

  // 地番 は 構成点 を 持つ 工事区域 と 地籍属性 を 持つ parcels の 2 枚
  const parcels: ParcelOption[] = workAreas.map((wa) => {
    const p = byWorkAreaId.get(wa.id) ?? null
    const src = wa.confirmedPoints.length > 0 ? wa.confirmedPoints : wa.points
    return {
      parcelId: p?.id && p.id !== 'pending' ? p.id : null,
      workAreaId: wa.id,
      label: p?.parcel_number || wa.name || wa.zoneNumber || wa.id.slice(0, 8),
      location: p?.location ?? null,
      points: src.map((q) => ({ id: q.id, pointNumber: q.pointNumber, x: q.x, y: q.y })),
      pointIds: wa.confirmedPoints.length > 0 ? wa.confirmedPointIds : wa.pointIds,
    }
  })

  // 与点 に 使える 点 = 基準点 (点種 control)
  const controls: ControlPointForDraw[] = useMemo(
    () =>
      coordinates
        // 基準点 と 国調成果 は 与点 に 使える
        .filter((c) => c.type === 'control' || c.type === 'national_survey')
        .map((c) => ({ id: c.id, pointNumber: c.pointNumber, x: c.x, y: c.y })),
    [coordinates],
  )

  const selected = useMemo(() => {
    if (selectedId) return drawings.find((p) => p.id === selectedId) ?? null
    return drawings[0] ?? null
  }, [drawings, selectedId])
  const currentId = selected?.id ?? null

  // 書き込み は 打鍵 ごと に 出さない
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<LandDrawPatch>({})
  const flush = useCallback(() => {
    if (!currentId) return
    const patch = pendingRef.current
    pendingRef.current = {}
    if (Object.keys(patch).length === 0) return
    void updateDrawing(currentId, patch)
  }, [currentId, updateDrawing])

  const onPatch = useCallback(
    (patch: LandDrawPatch) => {
      if (!currentId) return
      pendingRef.current = { ...pendingRef.current, ...patch }
      useLandDrawStore.setState((s) => ({
        drawings: s.drawings.map((p) => (p.id === currentId ? { ...p, ...patch } : p)),
      }))
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, 600)
    },
    [currentId, flush],
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      flush()
    }
  }, [flush])

  const handleCreate = async () => {
    if (!farmId) return
    const row = await createDrawing(farmId, zone)
    if (row) {
      setSelectedId(row.id)
      setStep(1)
    }
  }

  const handleDelete = async (p: LandSurveyDrawing) => {
    if (!window.confirm(`「${planTitle(p)}」を削除します。よろしいですか？`)) return
    await deleteDrawing(p.id)
    if (currentId === p.id) setSelectedId(null)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 whitespace-pre-line">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* 図面 の 一覧 */}
        <div className="w-64 shrink-0 border-r flex flex-col min-h-0 bg-slate-50">
          <div className="px-3 py-2 border-b flex items-center gap-2 bg-white">
            <Ruler className="h-4 w-4 text-slate-400" />
            <span className="text-sm font-semibold flex-1">地積測量図</span>
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-50 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" />
              新規
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                読み込み中…
              </div>
            ) : drawings.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-slate-400">
                図面がありません。
                <br />
                「新規」から作成します。
              </div>
            ) : (
              <ul className="divide-y">
                {drawings.map((p) => {
                  const picked = p.spec.parcelIds
                    .map((id) => parcels.find((q) => q.parcelId === id))
                    .filter((q): q is ParcelOption => q != null)
                  const total = picked.reduce(
                    (s, q) => s + calcParcelArea(q.label, q.points).registered,
                    0,
                  )
                  return (
                    <li
                      key={p.id}
                      onClick={() => {
                        flush()
                        setSelectedId(p.id)
                      }}
                      className={`px-3 py-2 cursor-pointer ${
                        currentId === p.id
                          ? 'bg-white border-l-2 border-blue-500'
                          : 'hover:bg-white/60'
                      }`}
                    >
                      <div className="text-sm truncate">{planTitle(p)}</div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {p.sheet_no > 1 && `${p.sheet_no}枚目 / `}
                        {picked.length} 筆 / {n2(total)} ㎡ / 1:{p.scale_denominator}
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void duplicateDrawing(p.id)
                          }}
                          className="p-0.5 text-slate-400 hover:text-slate-700"
                          title="複製"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleDelete(p)
                          }}
                          className="p-0.5 text-slate-400 hover:text-red-600"
                          title="削除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {/* 編集 */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
              左の一覧から図面を選ぶか、「新規」で作成してください
            </div>
          ) : (
            <>
              <div className="px-4 py-2 border-b bg-white flex items-center gap-1">
                {STEPS.map((s) => {
                  const on = step === s.key
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setStep(s.key)}
                      className={`px-3 py-1.5 rounded text-left ${
                        on ? 'bg-blue-600 text-white' : 'hover:bg-slate-100 text-slate-600'
                      }`}
                    >
                      <div className="text-xs font-semibold">
                        {s.key}. {s.label}
                      </div>
                      <div className={`text-[10px] ${on ? 'text-blue-100' : 'text-slate-400'}`}>
                        {s.hint}
                      </div>
                    </button>
                  )
                })}
                <div className="ml-auto text-[11px] text-slate-400">
                  {saving ? '保存中…' : '自動保存'}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-4">
                {step === 1 && (
                  <LandStepParcels
                    plan={selected}
                    parcels={parcels}
                    stakeById={stakeById}
                    farmId={farmId}
                    zone={zone}
                    conv={conv}
                    onPatch={onPatch}
                  />
                )}
                {step === 2 && (
                  <LandStepControls plan={selected} controls={controls} onPatch={onPatch} />
                )}
                {step === 3 && (
                  <LandStepFrame
                    plan={selected}
                    parcels={parcels}
                    controls={controls}
                    onPatch={onPatch}
                  />
                )}
              </div>

              <div className="px-4 py-2 border-t bg-white flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s))}
                  disabled={step === 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-40 hover:bg-slate-50"
                >
                  戻る
                </button>
                <button
                  type="button"
                  onClick={() => setStep((s) => (s < 3 ? ((s + 1) as 2 | 3) : s))}
                  disabled={step === 3}
                  className="px-3 py-1 text-sm border rounded bg-blue-600 text-white border-blue-600 disabled:opacity-40 hover:bg-blue-700"
                >
                  次へ
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
