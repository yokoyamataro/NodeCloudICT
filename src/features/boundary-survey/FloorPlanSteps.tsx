// 各階平面図 の 作成手順 (1〜4) の 中身。
//
//   1 建物情報   … 所在 / 地番 / 家屋番号
//   2 階層・形状 … 階 を 足し、矩形 の 縦横 で 形 を 作る
//   3 配置       … 地番 の 外形 に 1 階 を 載せる
//   4 図枠       … B4 の 枠 に 入れる 文字
//
// どの 段 も 「左 に 表題 / 右 に 入力欄」 に 揃える。

import { useMemo } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import {
  DEFAULT_PLACEMENT,
  defaultFloorName,
  floorArea,
  floorAreaText,
  newId,
  floorSizeSummary,
  rectsArea,
  totalArea,
  type FloorPlan,
  type FloorPlanFrame,
  type FloorPlanPlacement,
  type FloorRect,
  type FloorSpec,
} from './floorPlanTypes'
import { FloorShapePreview, PlacementPreview } from './FloorPlanPreview'
import type { FloorPlanPatch } from '@/stores/floorPlanStore'

type Patch = (patch: FloorPlanPatch) => void

/** 左 に 表題 / 右 に 入力欄 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="w-32 shrink-0 pt-1.5 text-xs text-slate-600">{label}</div>
      <div className="flex-1 min-w-0">
        {children}
        {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
      </div>
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 text-sm border rounded'
const numCls = 'w-28 px-2 py-1 text-sm border rounded text-right font-mono'

/** 入力中 の 空文字 を 0 に 潰さない ため の 数値読み取り */
const readNum = (v: string): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ========================================================================
// 1. 建物情報
// ========================================================================
export function StepBuilding({
  plan,
  parcels,
  onPatch,
}: {
  plan: FloorPlan
  parcels: WorkAreaRow[]
  onPatch: Patch
}) {
  return (
    <div className="max-w-2xl space-y-1">
      <Field label="図面名" hint="一覧の見出しに使います。空なら家屋番号で表示します。">
        <input
          className={inputCls}
          value={plan.title ?? ''}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="例: 〇〇様邸 各階平面図"
        />
      </Field>

      <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">建物の表示</div>

      <Field label="所在" hint="市区町村・大字・字まで。地番は下の欄に入れます。">
        <input
          className={inputCls}
          value={plan.location ?? ''}
          onChange={(e) => onPatch({ location: e.target.value })}
          placeholder="例: 〇〇市〇〇町字〇〇"
        />
      </Field>
      <Field label="地番">
        <input
          className={inputCls}
          value={plan.parcel_number ?? ''}
          onChange={(e) => onPatch({ parcel_number: e.target.value })}
          placeholder="例: 123番4"
        />
      </Field>
      <Field label="家屋番号">
        <input
          className={inputCls}
          value={plan.house_number ?? ''}
          onChange={(e) => onPatch({ house_number: e.target.value })}
          placeholder="例: 123番4"
        />
      </Field>
      <Field label="種類">
        <input
          className={inputCls}
          value={plan.building_kind ?? ''}
          onChange={(e) => onPatch({ building_kind: e.target.value })}
          placeholder="例: 居宅"
        />
      </Field>
      <Field label="構造">
        <input
          className={inputCls}
          value={plan.building_structure ?? ''}
          onChange={(e) => onPatch({ building_structure: e.target.value })}
          placeholder="例: 木造かわらぶき2階建"
        />
      </Field>

      {parcels.length > 0 && (
        <>
          <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">
            地番管理との紐づけ
          </div>
          <Field
            label="対象の地番"
            hint="選ぶと「3 配置」で敷地の外形を下敷きに使えます。"
          >
            <select
              className={inputCls}
              value={plan.parcel_id ?? ''}
              onChange={(e) => {
                const wa = parcels.find((p) => p.id === e.target.value)
                onPatch({
                  parcel_id: e.target.value || null,
                  // 地番名 が 空 なら 拾って おく
                  parcel_number: plan.parcel_number || (wa?.name ?? null),
                  placement: {
                    ...plan.placement,
                    parcelPointIds: wa ? wa.pointIds : [],
                  },
                })
              }}
            >
              <option value="">（紐づけない）</option>
              {parcels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.zoneNumber || p.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </div>
  )
}

// ========================================================================
// 2. 階層・形状寸法
// ========================================================================
export function StepFloors({
  plan,
  activeFloorId,
  onActiveFloor,
  onPatch,
}: {
  plan: FloorPlan
  activeFloorId: string | null
  onActiveFloor: (id: string) => void
  onPatch: Patch
}) {
  const floors = plan.floors
  const active = floors.find((f) => f.id === activeFloorId) ?? floors[0] ?? null

  const setFloors = (next: FloorSpec[]) => onPatch({ floors: next })

  const patchFloor = (id: string, p: Partial<FloorSpec>) =>
    setFloors(floors.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const addFloor = () => {
    const f: FloorSpec = {
      id: newId(),
      name: defaultFloorName(floors.length),
      rects: [{ x: 0, y: 0, w: 0, h: 0 }],
      areaSqm: null,
      areaOverride: false,
    }
    setFloors([...floors, f])
    onActiveFloor(f.id)
  }

  const moveFloor = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= floors.length) return
    const next = [...floors]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setFloors(next)
  }

  const patchRect = (fid: string, idx: number, p: Partial<FloorRect>) => {
    const f = floors.find((x) => x.id === fid)
    if (!f) return
    patchFloor(fid, { rects: f.rects.map((r, i) => (i === idx ? { ...r, ...p } : r)) })
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* 階 の 一覧 */}
      <div className="w-64 shrink-0 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold text-slate-500">階</div>
          <button
            type="button"
            onClick={addFloor}
            className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />
            階を追加
          </button>
        </div>
        <ul className="border rounded divide-y overflow-auto flex-1 min-h-0">
          {floors.length === 0 && (
            <li className="p-3 text-xs text-slate-400">
              「階を追加」から 1階 を作ってください。
            </li>
          )}
          {floors.map((f, i) => (
            <li
              key={f.id}
              className={`p-2 cursor-pointer ${
                active?.id === f.id ? 'bg-blue-50' : 'hover:bg-slate-50'
              }`}
              onClick={() => onActiveFloor(f.id)}
            >
              <div className="flex items-center gap-1">
                <input
                  className="flex-1 min-w-0 px-1 py-0.5 text-sm border rounded bg-white"
                  value={f.name}
                  onChange={(e) => patchFloor(f.id, { name: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); moveFloor(i, -1) }}
                  className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"
                  disabled={i === 0}
                  title="上へ"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); moveFloor(i, 1) }}
                  className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"
                  disabled={i === floors.length - 1}
                  title="下へ"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFloors(floors.filter((x) => x.id !== f.id))
                  }}
                  className="p-0.5 text-slate-400 hover:text-red-600"
                  title="この階を削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 font-mono">
                {floorSizeSummary(f)}
              </div>
            </li>
          ))}
        </ul>
        {floors.length > 0 && (
          <div className="mt-2 px-2 py-1.5 border rounded bg-slate-50 text-xs flex justify-between">
            <span className="text-slate-600">延べ床面積</span>
            <span className="font-mono font-semibold">
              {floorAreaText(totalArea(floors))} ㎡
            </span>
          </div>
        )}
      </div>

      {/* 選んだ 階 の 寸法 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            階を選んでください
          </div>
        ) : (
          <>
            <div className="text-xs font-semibold text-slate-500 mb-1">
              {active.name} の形状（矩形の縦横 / m）
            </div>
            <div className="border rounded overflow-auto max-h-56">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium w-10">#</th>
                    <th className="px-2 py-1 text-right font-medium">横 (東西)</th>
                    <th className="px-2 py-1 text-right font-medium">縦 (南北)</th>
                    <th className="px-2 py-1 text-right font-medium">基点 X</th>
                    <th className="px-2 py-1 text-right font-medium">基点 Y</th>
                    <th className="px-2 py-1 text-right font-medium">面積</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {active.rects.map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1 text-xs text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number"
                          step="0.01"
                          className={numCls}
                          value={r.w}
                          onChange={(e) =>
                            patchRect(active.id, i, { w: readNum(e.target.value) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number"
                          step="0.01"
                          className={numCls}
                          value={r.h}
                          onChange={(e) =>
                            patchRect(active.id, i, { h: readNum(e.target.value) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number"
                          step="0.01"
                          className={numCls}
                          value={r.x}
                          onChange={(e) =>
                            patchRect(active.id, i, { x: readNum(e.target.value) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number"
                          step="0.01"
                          className={numCls}
                          value={r.y}
                          onChange={(e) =>
                            patchRect(active.id, i, { y: readNum(e.target.value) })
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-xs text-slate-600">
                        {(Math.abs(r.w) * Math.abs(r.h)).toFixed(2)}
                      </td>
                      <td className="px-1">
                        <button
                          type="button"
                          onClick={() =>
                            patchFloor(active.id, {
                              rects: active.rects.filter((_, j) => j !== i),
                            })
                          }
                          className="p-0.5 text-slate-400 hover:text-red-600"
                          title="この矩形を削除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  patchFloor(active.id, {
                    rects: [...active.rects, { x: 0, y: 0, w: 0, h: 0 }],
                  })
                }
                className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                矩形を追加
              </button>
              <span className="text-[11px] text-slate-400">
                L字・凹型は矩形を足して表します（基点は 1 つめの矩形の左下からの相対位置）
              </span>
            </div>

            <div className="mt-2 flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={active.areaOverride}
                  onChange={(e) =>
                    patchFloor(active.id, {
                      areaOverride: e.target.checked,
                      areaSqm: e.target.checked ? rectsArea(active.rects) : null,
                    })
                  }
                />
                床面積を手入力する
              </label>
              <input
                type="number"
                step="0.01"
                className={`${numCls} ${active.areaOverride ? '' : 'bg-slate-100'}`}
                value={active.areaOverride ? (active.areaSqm ?? 0) : rectsArea(active.rects)}
                disabled={!active.areaOverride}
                onChange={(e) => patchFloor(active.id, { areaSqm: readNum(e.target.value) })}
              />
              <span className="text-slate-500">㎡</span>
              <span className="text-slate-400">
                登記面積 {floorAreaText(floorArea(active))} ㎡
              </span>
            </div>

            <div className="flex-1 min-h-0 mt-2 border rounded bg-white p-2">
              <FloorShapePreview floor={active} className="w-full h-full" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ========================================================================
// 3. 地番に対する配置
// ========================================================================
export function StepPlacement({
  plan,
  parcels,
  onPatch,
}: {
  plan: FloorPlan
  parcels: WorkAreaRow[]
  onPatch: Patch
}) {
  const placement = plan.placement ?? DEFAULT_PLACEMENT
  const setPlacement = (p: Partial<FloorPlanPlacement>) =>
    onPatch({ placement: { ...placement, ...p } })

  const parcel = useMemo(
    () => parcels.find((p) => p.id === plan.parcel_id) ?? null,
    [parcels, plan.parcel_id],
  )

  // 敷地 の 外形。 確定境界 が あれば そちら を 優先 する
  const sitePoints = useMemo(() => {
    if (!parcel) return []
    const src = parcel.confirmedPoints.length > 0 ? parcel.confirmedPoints : parcel.points
    return src.map((p) => ({ id: p.id, pointNumber: p.pointNumber, x: p.x, y: p.y }))
  }, [parcel])

  // 配置 は 1 階 で 見る (登記 で 敷地 との 関係 を 示す のは 1 階)
  const ground = plan.floors[0] ?? null

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-80 shrink-0 overflow-auto">
        <Field label="敷地の地番">
          <select
            className={inputCls}
            value={plan.parcel_id ?? ''}
            onChange={(e) => {
              const wa = parcels.find((p) => p.id === e.target.value)
              onPatch({
                parcel_id: e.target.value || null,
                placement: { ...placement, parcelPointIds: wa ? wa.pointIds : [] },
              })
            }}
          >
            <option value="">（選択）</option>
            {parcels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.zoneNumber || p.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </Field>

        {parcel && sitePoints.length === 0 && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            この地番にはまだ構成点がありません。地番管理で構成点を登録してください。
          </div>
        )}

        <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">
          1階の据え付け位置
        </div>
        <Field label="東方向 (Y)" hint="平面直角座標。建物の基点をどこに置くか。">
          <input
            type="number"
            step="0.001"
            className={numCls}
            value={placement.offsetE}
            onChange={(e) => setPlacement({ offsetE: readNum(e.target.value) })}
          />
        </Field>
        <Field label="北方向 (X)">
          <input
            type="number"
            step="0.001"
            className={numCls}
            value={placement.offsetN}
            onChange={(e) => setPlacement({ offsetN: readNum(e.target.value) })}
          />
        </Field>
        <Field label="建物の向き" hint="反時計回りの度。0 なら横が真東を向きます。">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              className={numCls}
              value={placement.rotationDeg}
              onChange={(e) => setPlacement({ rotationDeg: readNum(e.target.value) })}
            />
            <span className="text-xs text-slate-500">度</span>
          </div>
        </Field>

        {sitePoints.length > 0 && (
          <button
            type="button"
            onClick={() => {
              // 敷地 の 重心 に 寄せる。 細かい 位置 は 数値 で 詰めて もらう
              const e = sitePoints.reduce((s, p) => s + p.y, 0) / sitePoints.length
              const n = sitePoints.reduce((s, p) => s + p.x, 0) / sitePoints.length
              setPlacement({
                offsetE: Math.round(e * 1000) / 1000,
                offsetN: Math.round(n * 1000) / 1000,
              })
            }}
            className="mt-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
          >
            敷地の中心に寄せる
          </button>
        )}

        <div className="pt-3 mt-3 border-t">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-semibold text-slate-500">
              敷地境界からの離れ
            </div>
            <button
              type="button"
              onClick={() =>
                setPlacement({
                  refDistances: [
                    ...placement.refDistances,
                    { id: newId(), label: '', value: 0 },
                  ],
                })
              }
              className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" />
              追加
            </button>
          </div>
          {placement.refDistances.length === 0 ? (
            <div className="text-[11px] text-slate-400">
              図面に記入する寸法（例: 北側境界まで 1.20）を必要なだけ足します。
            </div>
          ) : (
            <ul className="space-y-1">
              {placement.refDistances.map((d, i) => (
                <li key={d.id} className="flex items-center gap-1">
                  <input
                    className="flex-1 min-w-0 px-2 py-1 text-sm border rounded"
                    placeholder="例: 北側境界まで"
                    value={d.label}
                    onChange={(e) =>
                      setPlacement({
                        refDistances: placement.refDistances.map((x, j) =>
                          j === i ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    type="number"
                    step="0.01"
                    className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
                    value={d.value}
                    onChange={(e) =>
                      setPlacement({
                        refDistances: placement.refDistances.map((x, j) =>
                          j === i ? { ...x, value: readNum(e.target.value) } : x,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setPlacement({
                        refDistances: placement.refDistances.filter((_, j) => j !== i),
                      })
                    }
                    className="p-1 text-slate-400 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 border rounded bg-white p-2">
        <PlacementPreview
          sitePoints={sitePoints}
          floor={ground}
          offsetE={placement.offsetE}
          offsetN={placement.offsetN}
          rotationDeg={placement.rotationDeg}
          className="w-full h-full"
        />
      </div>
    </div>
  )
}

// ========================================================================
// 4. 図枠要素
// ========================================================================
export function StepFrame({ plan, onPatch }: { plan: FloorPlan; onPatch: Patch }) {
  const frame = plan.frame
  const setFrame = (p: Partial<FloorPlanFrame>) => onPatch({ frame: { ...frame, ...p } })

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[26rem] shrink-0 overflow-auto space-y-1">
        <Field label="用紙">
          <div className="px-2 py-1 text-sm text-slate-600 bg-slate-100 rounded inline-block">
            B4（各階平面図の様式）
          </div>
        </Field>
        <Field label="縮尺" hint="各階平面図は 1/250 が原則です。">
          <div className="flex items-center gap-1">
            <span className="text-sm text-slate-600">1 /</span>
            <input
              type="number"
              className="w-24 px-2 py-1 text-sm border rounded text-right font-mono"
              value={plan.scale_denominator}
              onChange={(e) =>
                onPatch({ scale_denominator: Math.max(1, readNum(e.target.value)) })
              }
            />
          </div>
        </Field>
        <Field label="図面番号">
          <input
            className={inputCls}
            value={frame.drawingNumber}
            onChange={(e) => setFrame({ drawingNumber: e.target.value })}
          />
        </Field>
        <Field label="作成年月日">
          <input
            type="date"
            className={inputCls}
            value={frame.createdOn ?? ''}
            onChange={(e) => setFrame({ createdOn: e.target.value || null })}
          />
        </Field>
        <Field label="申請人">
          <input
            className={inputCls}
            value={frame.applicantName}
            onChange={(e) => setFrame({ applicantName: e.target.value })}
          />
        </Field>
        <Field label="作成者">
          <input
            className={inputCls}
            value={frame.surveyorName}
            onChange={(e) => setFrame({ surveyorName: e.target.value })}
            placeholder="土地家屋調査士 氏名"
          />
        </Field>
        <Field label="事務所">
          <input
            className={inputCls}
            value={frame.surveyorOffice}
            onChange={(e) => setFrame({ surveyorOffice: e.target.value })}
          />
        </Field>
        <Field label="方位" hint="図面の上を真北から何度振るか。0 なら上が真北。">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              className={numCls}
              value={frame.northAngleDeg}
              onChange={(e) => setFrame({ northAngleDeg: readNum(e.target.value) })}
            />
            <span className="text-xs text-slate-500">度</span>
          </div>
        </Field>
        <Field label="備考">
          <textarea
            className={`${inputCls} h-20`}
            value={frame.remarks}
            onChange={(e) => setFrame({ remarks: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="text-xs font-semibold text-slate-500 mb-1">図枠の下絵（B4 横）</div>
        <div className="flex-1 min-h-0 border rounded bg-slate-100 p-3 overflow-auto">
          <SheetPreview plan={plan} />
        </div>
        <div className="mt-1 text-[11px] text-slate-400">
          最終成果（p21 / tif / pdf）の出力はこの後の実装です。
        </div>
      </div>
    </div>
  )
}

/** B4 横 (364 × 257 mm) の 枠 に 中身 を 並べた 下絵 */
function SheetPreview({ plan }: { plan: FloorPlan }) {
  const W = 364
  const H = 257
  const m = 12 // 余白

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto bg-white shadow"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={0} y={0} width={W} height={H} fill="#fff" stroke="#cbd5e1" strokeWidth={0.4} />
      <rect
        x={m}
        y={m}
        width={W - m * 2}
        height={H - m * 2}
        fill="none"
        stroke="#334155"
        strokeWidth={0.8}
      />

      {/* 表題 */}
      <text x={m + 4} y={m + 10} fontSize={7} fontWeight="bold" fill="#0f172a">
        各階平面図
      </text>
      <text x={m + 4} y={m + 19} fontSize={4.5} fill="#334155">
        所在 {plan.location ?? ''} {plan.parcel_number ?? ''}
      </text>
      <text x={m + 4} y={m + 26} fontSize={4.5} fill="#334155">
        家屋番号 {plan.house_number ?? ''} 種類 {plan.building_kind ?? ''}
      </text>
      <text x={m + 4} y={m + 33} fontSize={4.5} fill="#334155">
        構造 {plan.building_structure ?? ''}
      </text>

      {/* 各階 の 形 を 横 に 並べる */}
      {plan.floors.slice(0, 4).map((f, i) => {
        const cw = (W - m * 2 - 90) / Math.min(Math.max(plan.floors.length, 1), 4)
        const cx = m + 4 + cw * i
        const cy = m + 40
        const ch = H - m * 2 - 52
        return (
          <g key={f.id}>
            <svg x={cx} y={cy} width={cw - 4} height={ch - 10}>
              <FloorShapePreview floor={f} className="w-full h-full" />
            </svg>
            <text x={cx + (cw - 4) / 2} y={cy + ch - 2} fontSize={4.5} textAnchor="middle" fill="#334155">
              {f.name} {floorAreaText(floorArea(f))} ㎡
            </text>
          </g>
        )
      })}

      {/* 右下 の 表題欄 */}
      <g>
        <rect
          x={W - m - 86}
          y={H - m - 56}
          width={86}
          height={56}
          fill="none"
          stroke="#334155"
          strokeWidth={0.6}
        />
        {[
          ['縮尺', `1/${plan.scale_denominator}`],
          ['作成年月日', plan.frame.createdOn ?? ''],
          ['申請人', plan.frame.applicantName],
          ['作成者', plan.frame.surveyorName],
          ['事務所', plan.frame.surveyorOffice],
          ['図面番号', plan.frame.drawingNumber],
        ].map(([k, v], i) => (
          <g key={k}>
            <line
              x1={W - m - 86}
              y1={H - m - 56 + 9.33 * (i + 1)}
              x2={W - m}
              y2={H - m - 56 + 9.33 * (i + 1)}
              stroke="#cbd5e1"
              strokeWidth={0.3}
            />
            <text x={W - m - 83} y={H - m - 56 + 9.33 * i + 6} fontSize={4} fill="#64748b">
              {k}
            </text>
            <text x={W - m - 55} y={H - m - 56 + 9.33 * i + 6} fontSize={4} fill="#0f172a">
              {v}
            </text>
          </g>
        ))}
      </g>

      {/* 方位 */}
      <g transform={`translate(${W - m - 100} ${m + 18}) rotate(${-plan.frame.northAngleDeg})`}>
        <line x1={0} y1={8} x2={0} y2={-8} stroke="#334155" strokeWidth={0.7} />
        <polygon points="0,-10 -2.2,-5 2.2,-5" fill="#334155" />
        <text x={0} y={-12} fontSize={4} textAnchor="middle" fill="#334155">
          N
        </text>
      </g>
    </svg>
  )
}
