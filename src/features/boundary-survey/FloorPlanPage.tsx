// 地籍測量: 建物図面・各階平面図 の 作成ページ。
//
// 登記 に 出す B4 1 枚 に 「各階平面図 (左)」 と 「建物図面 (右)」 が 同居 する。
// doc/tatemono1.tif が 実物。 1 工区 に 複数枚 作る ので 「左 に 図面 の 一覧 /
// 右 に 編集」 の 形 に する。 編集 は 作成 の 順序 そのまま の 4 段:
//   1 建物情報 → 2 階層・形状寸法 (+ 求積表) → 3 地番に対する配置 → 4 図枠要素
//
// 最終成果 (p21 / tif / pdf) の 出力 は この後 の 実装。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, LayoutTemplate, Loader2, Plus, Trash2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFloorPlanStore, type FloorPlanPatch } from '@/stores/floorPlanStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  floorAreaText,
  totalMainArea,
  type FloorPlan,
  type ParcelOption,
} from './floorPlanTypes'
import { StepBuilding, StepFigures, StepFrame, StepSite } from './FloorPlanSteps'

const STEPS = [
  { key: 1, label: '建物情報', hint: '所在・作製者・申請人' },
  { key: 2, label: '階層・形状寸法', hint: '形状と求積表' },
  { key: 3, label: '配置', hint: '建物図面（右半分）' },
  { key: 4, label: '図枠要素', hint: '縮尺と出力' },
] as const

/** 一覧 に 出す 見出し */
function planTitle(p: FloorPlan): string {
  if (p.title && p.title.trim() !== '') return p.title
  if (p.house_number) return `家屋番号 ${p.house_number}`
  if (p.parcel_number) return `${p.parcel_number}`
  return '（無題の図面）'
}

export function FloorPlanPage() {
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null

  const { plans, loading, saving, error, fetchByFarm, createPlan, duplicatePlan, updatePlan, deletePlan } =
    useFloorPlanStore()
  const { getWorkAreasByType, fetchWorkAreas } = useWorkAreaStore()
  // 地図 の 初期中心 は 座標 の 先頭。 読んで いない と 東京 に 飛ぶ
  const fetchCoordinates = useCoordinateStore((s) => s.fetchCoordinates)
  const { byWorkAreaId, fetchByWorkAreaIds, upsertParcel } = useParcelStore()
  const { projects } = useProjectListStore()

  // 建物 は 平面直角座標 で 計算 する ので、地図 に 出す とき に 緯度経度 へ 直す
  const zone = useMemo(
    () => projects.find((p) => p.id === currentFarm?.project_id)?.coordinate_zone ?? 13,
    [projects, currentFarm],
  )
  const conv = useMemo(() => new CoordinateConverter(zone), [zone])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [activeFigureId, setActiveFigureId] = useState<string | null>(null)

  useEffect(() => {
    if (farmId) {
      void fetchByFarm(farmId)
      void fetchWorkAreas(farmId)
      void fetchCoordinates(farmId)
    }
  }, [farmId, fetchByFarm, fetchWorkAreas, fetchCoordinates])

  // 地番 は 構成点 を 持つ design_work_areas と 地籍属性 を 持つ parcels の
  // 2 枚 に 分かれて いる。 図面 が 指す のは parcels の 方 な ので 束ねて 渡す。
  // getWorkAreasByType は 呼ぶ たび に 現在 の 状態 を 読む ので useMemo に
  // 入れて しまう と 読み込み 後 に 更新 されない。 毎回 呼ぶ。
  const workAreas = getWorkAreasByType('boundary_survey')

  useEffect(() => {
    if (workAreas.length > 0) void fetchByWorkAreaIds(workAreas.map((w) => w.id))
    // 工区 が 変われば 工事区域 も 入れ替わる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, workAreas.length, fetchByWorkAreaIds])

  const parcels: ParcelOption[] = workAreas.map((wa) => {
    const p = byWorkAreaId.get(wa.id) ?? null
    // 確定境界 が あれば そちら を 敷地 の 外形 に 使う
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

  /**
   * 地番 を 付け外し する。 建物 が 複数 の 土地 に またがる こと が ある ので
   * 一覧 で 持つ。 floor_plans.parcel_id は parcels.id を 指す ので、地籍属性 の
   * 行 が まだ 無い 地番 は ここ で 作って から 結びつける。
   */
  const handleToggleParcel = async (workAreaId: string) => {
    const opt = parcels.find((p) => p.workAreaId === workAreaId)
    if (!opt || !selected) return
    const site = selected.site

    let parcelId = opt.parcelId
    if (!parcelId) {
      const created = await upsertParcel(workAreaId, {})
      parcelId = created?.id ?? null
      if (!parcelId) return
    }

    const has = site.parcelIds.includes(parcelId)
    const nextIds = has
      ? site.parcelIds.filter((x) => x !== parcelId)
      : [...site.parcelIds, parcelId]

    // 構成点 は 選んだ 地番 を 順 に 繋げた もの
    const nextPointIds = nextIds.flatMap(
      (id) => parcels.find((p) => p.parcelId === id)?.pointIds ?? [],
    )
    const head = nextIds[0] ?? null
    const headOpt = head ? parcels.find((p) => p.parcelId === head) : null

    onPatch({
      parcel_id: head,
      parcel_number: selected.parcel_number || headOpt?.label || null,
      site: {
        ...site,
        parcelIds: nextIds,
        parcelPointIds: nextPointIds,
        // 敷地 が 変われば 据え直し
        placed: has || nextIds.length === 0 ? false : site.placed,
      },
    })
  }

  // 未選択 の 間 は 先頭 を 開いた こと に する (effect で setState しない)
  const selected = useMemo(() => {
    if (selectedId) return plans.find((p) => p.id === selectedId) ?? null
    return plans[0] ?? null
  }, [plans, selectedId])
  const currentId = selected?.id ?? null

  // 書き込み は 打鍵 ごと に 出さない。 画面 は すぐ 変わる (ストア が 先に 反映)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<FloorPlanPatch>({})
  const flush = useCallback(() => {
    if (!currentId) return
    const patch = pendingRef.current
    pendingRef.current = {}
    if (Object.keys(patch).length === 0) return
    void updatePlan(currentId, patch)
  }, [currentId, updatePlan])

  const onPatch = useCallback(
    (patch: FloorPlanPatch) => {
      if (!currentId) return
      pendingRef.current = { ...pendingRef.current, ...patch }
      // 先 に 画面 だけ 反映 させる
      useFloorPlanStore.setState((s) => ({
        plans: s.plans.map((p) => (p.id === currentId ? { ...p, ...patch } : p)),
      }))
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, 600)
    },
    [currentId, flush],
  )

  // 図面 を 切り替える / 画面 を 離れる ときに 書き残し を 出す
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      flush()
    }
  }, [flush])

  const handleCreate = async () => {
    if (!farmId) return
    const row = await createPlan(farmId)
    if (row) {
      setSelectedId(row.id)
      setStep(1)
    }
  }

  const handleDelete = async (p: FloorPlan) => {
    if (!window.confirm(`「${planTitle(p)}」を削除します。よろしいですか？`)) return
    await deletePlan(p.id)
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
            <LayoutTemplate className="h-4 w-4 text-slate-400" />
            <span className="text-sm font-semibold flex-1">各階平面図</span>
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
            ) : plans.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-slate-400">
                図面がありません。
                <br />
                「新規」から作成します。
              </div>
            ) : (
              <ul className="divide-y">
                {plans.map((p) => (
                  <li
                    key={p.id}
                    onClick={() => {
                      flush()
                      setSelectedId(p.id)
                      setActiveFigureId(null)
                    }}
                    className={`px-3 py-2 cursor-pointer ${
                      currentId === p.id ? 'bg-white border-l-2 border-blue-500' : 'hover:bg-white/60'
                    }`}
                  >
                    <div className="text-sm truncate">{planTitle(p)}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {p.sheet_no > 1 && `${p.sheet_no}枚目 / `}
                      {p.figures.length} 図形 / {floorAreaText(totalMainArea(p.figures))} ㎡
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void duplicatePlan(p.id)
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
                ))}
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
                  <StepBuilding
                    plan={selected}
                    parcels={parcels}
                    onToggleParcel={(id) => void handleToggleParcel(id)}
                    onPatch={onPatch}
                  />
                )}
                {step === 2 && (
                  <StepFigures
                    plan={selected}
                    activeFigureId={activeFigureId}
                    onActiveFigure={setActiveFigureId}
                    onPatch={onPatch}
                  />
                )}
                {step === 3 && (
                  <StepSite
                    plan={selected}
                    parcels={parcels}
                    farmId={farmId}
                    zone={zone}
                    conv={conv}
                    onToggleParcel={(id) => void handleToggleParcel(id)}
                    onPatch={onPatch}
                  />
                )}
                {step === 4 && (
                  <StepFrame plan={selected} parcels={parcels} onPatch={onPatch} />
                )}
              </div>

              <div className="px-4 py-2 border-t bg-white flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
                  disabled={step === 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-40 hover:bg-slate-50"
                >
                  戻る
                </button>
                <button
                  type="button"
                  onClick={() => setStep((s) => (s < 4 ? ((s + 1) as 2 | 3 | 4) : s))}
                  disabled={step === 4}
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
