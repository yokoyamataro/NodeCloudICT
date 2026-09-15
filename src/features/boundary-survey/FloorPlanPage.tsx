// 地籍測量: 各階平面図作成ページ。
//
// 1 工区 に 複数枚 作る ので 「左 に 図面 の 一覧 / 右 に 編集」 の 形 に する。
// 編集 は 作成 の 順序 そのまま の 4 段:
//   1 建物情報 → 2 階層・形状寸法 → 3 地番に対する配置 → 4 図枠要素
//
// 最終成果 (B4 の p21 / tif / pdf) の 出力 は この後 の 実装。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, LayoutTemplate, Loader2, Plus, Trash2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useFloorPlanStore, type FloorPlanPatch } from '@/stores/floorPlanStore'
import { floorAreaText, totalArea, type FloorPlan } from './floorPlanTypes'
import { StepBuilding, StepFloors, StepFrame, StepPlacement } from './FloorPlanSteps'

const STEPS = [
  { key: 1, label: '建物情報', hint: '所在・地番・家屋番号' },
  { key: 2, label: '階層・形状寸法', hint: '階ごとの縦横' },
  { key: 3, label: '配置', hint: '地番に対する位置' },
  { key: 4, label: '図枠要素', hint: 'B4 の枠' },
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

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null)

  useEffect(() => {
    if (farmId) {
      void fetchByFarm(farmId)
      void fetchWorkAreas(farmId)
    }
  }, [farmId, fetchByFarm, fetchWorkAreas])

  // 地番 (境界測量 の 工事区域) を 配置 の 下敷き に 使う。
  // getWorkAreasByType は 呼ぶ たび に 現在 の 状態 を 読む ので useMemo に
  // 入れて しまう と 読み込み 後 に 更新 されない。 毎回 呼ぶ。
  const parcels = getWorkAreasByType('boundary_survey')

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
                      setActiveFloorId(null)
                    }}
                    className={`px-3 py-2 cursor-pointer ${
                      currentId === p.id ? 'bg-white border-l-2 border-blue-500' : 'hover:bg-white/60'
                    }`}
                  >
                    <div className="text-sm truncate">{planTitle(p)}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {p.floors.length} 階 / {floorAreaText(totalArea(p.floors))} ㎡
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
                  <StepBuilding plan={selected} parcels={parcels} onPatch={onPatch} />
                )}
                {step === 2 && (
                  <StepFloors
                    plan={selected}
                    activeFloorId={activeFloorId}
                    onActiveFloor={setActiveFloorId}
                    onPatch={onPatch}
                  />
                )}
                {step === 3 && (
                  <StepPlacement plan={selected} parcels={parcels} onPatch={onPatch} />
                )}
                {step === 4 && <StepFrame plan={selected} onPatch={onPatch} />}
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
