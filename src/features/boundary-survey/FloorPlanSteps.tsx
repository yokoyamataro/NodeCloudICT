// 建物図面・各階平面図 の 作成手順 (1〜4) の 中身。
//
//   1 建物情報   … 所在 / 地番 / 家屋番号
//   2 階層・形状 … 図形 (主である建物 の 各階 / 附属建物) の 多角形 と 求積表
//   3 配置       … 用紙 右半分 の 建物図面 (敷地 に 載せる)
//   4 図枠       … 表題欄 と 縮尺、 B4 の 下絵
//
// どの 段 も 「左 に 表題 / 右 に 入力欄」 に 揃える。

import { useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import {
  TERM_KIND_LABEL,
  edgeLength,
  figureFloorArea,
  figureLabel,
  figureSum,
  floorAreaText,
  groundFigure,
  newFigure,
  newId,
  newTerm,
  outlineSummary,
  polygonArea,
  rectOutline,
  sortFigures,
  termFormula,
  termValue,
  termValueText,
  totalMainArea,
  warekiCreatedText,
  type AreaTerm,
  type FloorFigure,
  type FloorPlan,
  type FloorPlanFrame,
  type Pt,
  type SitePlan,
  type TermKind,
} from './floorPlanTypes'
import { FigureOutlinePreview, SitePlanPreview } from './FloorPlanPreview'
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
      <div className="w-28 shrink-0 pt-1.5 text-xs text-slate-600">{label}</div>
      <div className="flex-1 min-w-0">
        {children}
        {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
      </div>
    </div>
  )
}

const inputCls = 'w-full px-2 py-1 text-sm border rounded'
const numCls = 'w-24 px-2 py-1 text-sm border rounded text-right font-mono'

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
          placeholder="例: 〇〇様邸"
        />
      </Field>
      <Field label="枚数" hint="1 申請が 1 枚に収まらないとき、2 枚目以降に分けます。">
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            className={numCls}
            value={plan.sheet_no}
            onChange={(e) => onPatch({ sheet_no: Math.max(1, readNum(e.target.value)) })}
          />
          <span className="text-xs text-slate-500">枚目</span>
        </div>
      </Field>

      <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">
        用紙上部に出る表示
      </div>

      <Field label="家屋番号">
        <input
          className={inputCls}
          value={plan.house_number ?? ''}
          onChange={(e) => onPatch({ house_number: e.target.value })}
          placeholder="例: 54番10"
        />
      </Field>
      <Field label="建物の所在" hint="「斜里郡斜里町光陽町54番地10」のように地番まで入れます。">
        <input
          className={inputCls}
          value={plan.location ?? ''}
          onChange={(e) => onPatch({ location: e.target.value })}
          placeholder="例: 斜里郡斜里町光陽町54番地10"
        />
      </Field>

      <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">
        参考情報（申請書と合わせる用。図面には出しません）
      </div>
      <Field label="地番">
        <input
          className={inputCls}
          value={plan.parcel_number ?? ''}
          onChange={(e) => onPatch({ parcel_number: e.target.value })}
          placeholder="例: 54番10"
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
          <Field label="敷地の地番" hint="選ぶと「3 配置」で敷地の外形を下敷きに使えます。">
            <select
              className={inputCls}
              value={plan.parcel_id ?? ''}
              onChange={(e) => {
                const wa = parcels.find((p) => p.id === e.target.value)
                onPatch({
                  parcel_id: e.target.value || null,
                  parcel_number: plan.parcel_number || (wa?.name ?? null),
                  site: { ...plan.site, parcelPointIds: wa ? wa.pointIds : [] },
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
// 2. 階層・形状寸法 と 求積表
// ========================================================================
export function StepFigures({
  plan,
  activeFigureId,
  onActiveFigure,
  onPatch,
}: {
  plan: FloorPlan
  activeFigureId: string | null
  onActiveFigure: (id: string) => void
  onPatch: Patch
}) {
  const figures = plan.figures
  const active = figures.find((f) => f.id === activeFigureId) ?? figures[0] ?? null
  const ground = groundFigure(figures)

  const setFigures = (next: FloorFigure[]) => onPatch({ figures: next })
  const patchFigure = (id: string, p: Partial<FloorFigure>) =>
    setFigures(figures.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const addFigure = (kind: 'main' | 'annex') => {
    const same = figures.filter((f) => f.kind === kind)
    const f =
      kind === 'main'
        ? newFigure('main', same.length + 1, null)
        : newFigure(
            'annex',
            1,
            same.reduce((m, x) => Math.max(m, x.annexNo ?? 0), 0) + 1,
          )
    setFigures([...figures, f])
    onActiveFigure(f.id)
  }

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= figures.length) return
    const next = [...figures]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setFigures(next)
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* 図形 の 一覧 */}
      <div className="w-60 shrink-0 flex flex-col min-h-0">
        <div className="text-xs font-semibold text-slate-500 mb-1">図形</div>
        <div className="flex gap-1 mb-1">
          <button
            type="button"
            onClick={() => addFigure('main')}
            className="flex-1 px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center justify-center gap-1"
          >
            <Plus className="h-3 w-3" />
            階を追加
          </button>
          <button
            type="button"
            onClick={() => addFigure('annex')}
            className="flex-1 px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center justify-center gap-1"
          >
            <Plus className="h-3 w-3" />
            附属建物
          </button>
        </div>
        <ul className="border rounded divide-y overflow-auto flex-1 min-h-0">
          {figures.length === 0 && (
            <li className="p-3 text-xs text-slate-400">
              「階を追加」で 主である建物1階 から作ります。
            </li>
          )}
          {figures.map((f, i) => (
            <li
              key={f.id}
              onClick={() => onActiveFigure(f.id)}
              className={`p-2 cursor-pointer ${
                active?.id === f.id ? 'bg-blue-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-sm truncate">{figureLabel(f)}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); move(i, -1) }}
                  disabled={i === 0}
                  className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); move(i, 1) }}
                  disabled={i === figures.length - 1}
                  className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFigures(figures.filter((x) => x.id !== f.id))
                  }}
                  className="p-0.5 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                {outlineSummary(f.outline)} / 床面積 {floorAreaText(figureFloorArea(f))} ㎡
              </div>
            </li>
          ))}
        </ul>
        {figures.length > 0 && (
          <div className="mt-2 px-2 py-1.5 border rounded bg-slate-50 text-xs flex justify-between">
            <span className="text-slate-600">主である建物 延べ床</span>
            <span className="font-mono font-semibold">
              {floorAreaText(totalMainArea(figures))} ㎡
            </span>
          </div>
        )}
      </div>

      {/* 選んだ 図形 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            図形を選んでください
          </div>
        ) : (
          <FigureEditor
            figure={active}
            underlay={active.id === ground?.id ? null : ground}
            onChange={(p) => patchFigure(active.id, p)}
          />
        )}
      </div>
    </div>
  )
}

/** 1 つ の 図形 の 形状 + 求積表 */
function FigureEditor({
  figure,
  underlay,
  onChange,
}: {
  figure: FloorFigure
  underlay: FloorFigure | null
  onChange: (p: Partial<FloorFigure>) => void
}) {
  const [tab, setTab] = useState<'shape' | 'area'>('shape')
  const sum = figureSum(figure)
  const poly = polygonArea(figure.outline)
  // 求積表 と 図形 が 食い違って いたら 気づける ように
  const mismatch = figure.outline.length >= 3 && Math.abs(poly - sum) > 0.005

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm font-semibold">{figureLabel(figure)}</div>
        <div className="flex items-center gap-1 ml-2">
          <label className="text-xs text-slate-500">階</label>
          <input
            type="number"
            className="w-16 px-2 py-0.5 text-sm border rounded text-right"
            value={figure.floorNo}
            onChange={(e) => onChange({ floorNo: Math.trunc(readNum(e.target.value)) || 1 })}
          />
          {figure.kind === 'annex' && (
            <>
              <label className="ml-2 text-xs text-slate-500">符号</label>
              <input
                type="number"
                className="w-16 px-2 py-0.5 text-sm border rounded text-right"
                value={figure.annexNo ?? 1}
                onChange={(e) => onChange({ annexNo: Math.trunc(readNum(e.target.value)) || 1 })}
              />
            </>
          )}
        </div>
        <div className="ml-auto flex rounded border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setTab('shape')}
            className={`px-3 py-1 ${tab === 'shape' ? 'bg-blue-600 text-white' : 'hover:bg-slate-50'}`}
          >
            形状
          </button>
          <button
            type="button"
            onClick={() => setTab('area')}
            className={`px-3 py-1 border-l ${tab === 'area' ? 'bg-blue-600 text-white' : 'hover:bg-slate-50'}`}
          >
            求積表
          </button>
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">
        <div className="w-[26rem] shrink-0 flex flex-col min-h-0">
          {tab === 'shape' ? (
            <OutlineEditor figure={figure} onChange={onChange} />
          ) : (
            <AreaTable figure={figure} onChange={onChange} />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 border rounded bg-white p-2">
            <FigureOutlinePreview
              figure={figure}
              underlay={underlay}
              className="w-full h-full"
            />
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs">
            <span className="text-slate-500">
              求積 計 <span className="font-mono">{termValueText(sum)}</span>
            </span>
            <span className="font-semibold">
              床面積 <span className="font-mono">{floorAreaText(figureFloorArea(figure))}</span> ㎡
            </span>
            {figure.outline.length >= 3 && (
              <span className={mismatch ? 'text-amber-700' : 'text-slate-400'}>
                図形の座標法 <span className="font-mono">{poly.toFixed(6)}</span>
                {mismatch && ' … 求積表と一致しません'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 形状: 点 の 表 + 辺 を 足す 補助 */
function OutlineEditor({
  figure,
  onChange,
}: {
  figure: FloorFigure
  onChange: (p: Partial<FloorFigure>) => void
}) {
  const pts = figure.outline
  const [dir, setDir] = useState<'E' | 'W' | 'N' | 'S'>('E')
  const [len, setLen] = useState(0)
  const [seedW, setSeedW] = useState(0)
  const [seedH, setSeedH] = useState(0)

  const setPts = (next: Pt[]) => onChange({ outline: next })

  const appendEdge = () => {
    if (len === 0) return
    const last = pts[pts.length - 1] ?? { x: 0, y: 0 }
    const d = { E: [len, 0], W: [-len, 0], N: [0, len], S: [0, -len] }[dir]
    const next = [...(pts.length === 0 ? [{ x: 0, y: 0 }] : pts)]
    next.push({
      x: Math.round((last.x + d[0]) * 1000) / 1000,
      y: Math.round((last.y + d[1]) * 1000) / 1000,
    })
    setPts(next)
  }

  return (
    <div className="flex flex-col min-h-0">
      {pts.length === 0 && (
        <div className="mb-2 p-2 border rounded bg-slate-50">
          <div className="text-xs font-semibold text-slate-600 mb-1">矩形から始める</div>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-xs text-slate-500">横</span>
            <input
              type="number"
              step="0.001"
              className={numCls}
              value={seedW}
              onChange={(e) => setSeedW(readNum(e.target.value))}
            />
            <span className="text-xs text-slate-500">縦</span>
            <input
              type="number"
              step="0.001"
              className={numCls}
              value={seedH}
              onChange={(e) => setSeedH(readNum(e.target.value))}
            />
            <button
              type="button"
              onClick={() => seedW > 0 && seedH > 0 && setPts(rectOutline(seedW, seedH))}
              className="px-2 py-1 text-xs border rounded hover:bg-white"
            >
              作成
            </button>
          </div>
        </div>
      )}

      <div className="border rounded overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium w-8">#</th>
              <th className="px-2 py-1 text-right font-medium">X（東）</th>
              <th className="px-2 py-1 text-right font-medium">Y（北）</th>
              <th className="px-2 py-1 text-right font-medium">辺長</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {pts.map((p, i) => (
              <tr key={i}>
                <td className="px-2 py-1 text-xs text-slate-400">{i + 1}</td>
                <td className="px-2 py-1 text-right">
                  <input
                    type="number"
                    step="0.001"
                    className={numCls}
                    value={p.x}
                    onChange={(e) =>
                      setPts(pts.map((q, j) => (j === i ? { ...q, x: readNum(e.target.value) } : q)))
                    }
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <input
                    type="number"
                    step="0.001"
                    className={numCls}
                    value={p.y}
                    onChange={(e) =>
                      setPts(pts.map((q, j) => (j === i ? { ...q, y: readNum(e.target.value) } : q)))
                    }
                  />
                </td>
                <td className="px-2 py-1 text-right font-mono text-xs text-slate-600">
                  {edgeLength(pts, i).toFixed(3)}
                </td>
                <td className="px-1">
                  <button
                    type="button"
                    onClick={() => setPts(pts.filter((_, j) => j !== i))}
                    className="p-0.5 text-slate-400 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 p-2 border rounded bg-slate-50">
        <div className="text-xs font-semibold text-slate-600 mb-1">辺を足す</div>
        <div className="flex items-center gap-1">
          <select
            className="px-2 py-1 text-sm border rounded"
            value={dir}
            onChange={(e) => setDir(e.target.value as 'E' | 'W' | 'N' | 'S')}
          >
            <option value="E">右（東）へ</option>
            <option value="W">左（西）へ</option>
            <option value="N">上（北）へ</option>
            <option value="S">下（南）へ</option>
          </select>
          <input
            type="number"
            step="0.001"
            className={numCls}
            value={len}
            onChange={(e) => setLen(readNum(e.target.value))}
          />
          <span className="text-xs text-slate-500">m</span>
          <button
            type="button"
            onClick={appendEdge}
            className="px-2 py-1 text-xs border rounded hover:bg-white flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />
            追加
          </button>
        </div>
        <div className="mt-1 text-[11px] text-slate-400">
          隅切りなど斜めの辺は、点の X / Y を直接入れてください。最後の点と 1 点目は自動で閉じます。
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-slate-500">1階からのずれ</span>
        <span className="text-slate-400">X</span>
        <input
          type="number"
          step="0.001"
          className={numCls}
          value={figure.offset.x}
          onChange={(e) => onChange({ offset: { ...figure.offset, x: readNum(e.target.value) } })}
        />
        <span className="text-slate-400">Y</span>
        <input
          type="number"
          step="0.001"
          className={numCls}
          value={figure.offset.y}
          onChange={(e) => onChange({ offset: { ...figure.offset, y: readNum(e.target.value) } })}
        />
      </div>
    </div>
  )
}

/** 求積表 */
function AreaTable({
  figure,
  onChange,
}: {
  figure: FloorFigure
  onChange: (p: Partial<FloorFigure>) => void
}) {
  const terms = figure.terms
  const setTerms = (next: AreaTerm[]) => onChange({ terms: next })
  const patch = (i: number, p: Partial<AreaTerm>) =>
    setTerms(terms.map((t, j) => (j === i ? { ...t, ...p } : t)))

  return (
    <div className="flex flex-col min-h-0">
      <div className="border rounded overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium">種類</th>
              <th className="px-2 py-1 text-right font-medium">a</th>
              <th className="px-2 py-1 text-right font-medium">b</th>
              <th className="px-2 py-1 text-right font-medium">高さ</th>
              <th className="px-2 py-1 text-right font-medium">面積</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {terms.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-xs text-slate-400">
                  「行を追加」で求積の式を並べます。
                </td>
              </tr>
            )}
            {terms.map((t, i) => (
              <tr key={t.id}>
                <td className="px-1 py-1">
                  <select
                    className="px-1 py-0.5 text-xs border rounded"
                    value={t.kind}
                    onChange={(e) => patch(i, { kind: e.target.value as TermKind })}
                  >
                    {(Object.keys(TERM_KIND_LABEL) as TermKind[]).map((k) => (
                      <option key={k} value={k}>
                        {TERM_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </td>
                {t.kind === 'manual' ? (
                  <>
                    <td className="px-1 py-1" colSpan={3}>
                      <input
                        className="w-full px-1 py-0.5 text-xs border rounded"
                        placeholder="式（図面に出す文字）"
                        value={t.note}
                        onChange={(e) => patch(i, { note: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <input
                        type="number"
                        step="0.000001"
                        className="w-24 px-1 py-0.5 text-xs border rounded text-right font-mono"
                        value={t.manual}
                        onChange={(e) => patch(i, { manual: readNum(e.target.value) })}
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-1 py-1 text-right">
                      <input
                        type="number"
                        step="0.001"
                        className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
                        value={t.a}
                        onChange={(e) => patch(i, { a: readNum(e.target.value) })}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <input
                        type="number"
                        step="0.001"
                        className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
                        value={t.b}
                        onChange={(e) => patch(i, { b: readNum(e.target.value) })}
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      {t.kind === 'trapezoid' ? (
                        <input
                          type="number"
                          step="0.001"
                          className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
                          value={t.h}
                          onChange={(e) => patch(i, { h: readNum(e.target.value) })}
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right font-mono text-xs">
                      {termValueText(termValue(t))}
                    </td>
                  </>
                )}
                <td className="px-1">
                  <button
                    type="button"
                    onClick={() => setTerms(terms.filter((_, j) => j !== i))}
                    className="p-0.5 text-slate-400 hover:text-red-600"
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
          onClick={() => setTerms([...terms, newTerm('rect')])}
          className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          行を追加
        </button>
        <span className="text-[11px] text-slate-400">
          長方形 a×b / 台形 (a+b)×h÷2 / 三角形 a×b÷2
        </span>
      </div>

      {/* 図面 に 出る 見え方 */}
      {terms.length > 0 && (
        <div className="mt-2 p-2 border rounded bg-white font-mono text-[11px] leading-5">
          <div className="font-sans font-semibold text-slate-600 mb-1">求積表</div>
          {terms.map((t) => (
            <div key={t.id} className="flex justify-between">
              <span>{termFormula(t)}</span>
              <span>= {termValueText(termValue(t))}</span>
            </div>
          ))}
          <div className="flex justify-between border-t mt-1 pt-1">
            <span className="font-sans">計</span>
            <span>{termValueText(figureSum(figure))}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-sans">床面積</span>
            <span>{floorAreaText(figureFloorArea(figure))} ㎡</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ========================================================================
// 3. 地番に対する配置 (用紙 右半分 の 建物図面)
// ========================================================================
export function StepSite({
  plan,
  parcels,
  onPatch,
}: {
  plan: FloorPlan
  parcels: WorkAreaRow[]
  onPatch: Patch
}) {
  const site = plan.site
  const setSite = (p: Partial<SitePlan>) => onPatch({ site: { ...site, ...p } })

  const parcel = parcels.find((p) => p.id === plan.parcel_id) ?? null
  // 確定境界 が あれば そちら を 使う
  const src = parcel
    ? parcel.confirmedPoints.length > 0
      ? parcel.confirmedPoints
      : parcel.points
    : []
  const sitePoints = src.map((p) => ({
    id: p.id,
    pointNumber: p.pointNumber,
    x: p.x,
    y: p.y,
  }))

  const ground = groundFigure(plan.figures)

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
                site: { ...site, parcelPointIds: wa ? wa.pointIds : [] },
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
        {!ground && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            「2 階層・形状寸法」で 主である建物1階 の形状を入れてください。建物図面はその外形を使います。
          </div>
        )}

        <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">
          1階の据え付け位置
        </div>
        <Field label="東方向 (Y)" hint="平面直角座標。建物の 1 点目をどこに置くか。">
          <input
            type="number"
            step="0.001"
            className={numCls}
            value={site.offsetE}
            onChange={(e) => setSite({ offsetE: readNum(e.target.value) })}
          />
        </Field>
        <Field label="北方向 (X)">
          <input
            type="number"
            step="0.001"
            className={numCls}
            value={site.offsetN}
            onChange={(e) => setSite({ offsetN: readNum(e.target.value) })}
          />
        </Field>
        <Field label="建物の向き" hint="反時計回りの度。0 なら横が真東を向きます。">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              className={numCls}
              value={site.rotationDeg}
              onChange={(e) => setSite({ rotationDeg: readNum(e.target.value) })}
            />
            <span className="text-xs text-slate-500">度</span>
          </div>
        </Field>
        <Field label="方位" hint="図面の上を真北から何度振るか。0 なら上が真北。">
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              className={numCls}
              value={site.northAngleDeg}
              onChange={(e) => setSite({ northAngleDeg: readNum(e.target.value) })}
            />
            <span className="text-xs text-slate-500">度</span>
          </div>
        </Field>

        {sitePoints.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const e = sitePoints.reduce((s, p) => s + p.y, 0) / sitePoints.length
              const n = sitePoints.reduce((s, p) => s + p.x, 0) / sitePoints.length
              setSite({
                offsetE: Math.round(e * 1000) / 1000,
                offsetN: Math.round(n * 1000) / 1000,
              })
            }}
            className="mt-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
          >
            敷地の中心に寄せる
          </button>
        )}

        <ListEditor
          title="隣地の地番など（注記）"
          empty="例: 54-11 / 292 のように、隣接地の地番を図に添えます。"
          ids={site.notes.map((n) => n.id)}
          onAdd={() =>
            setSite({ notes: [...site.notes, { id: newId(), label: '', x: 0, y: 0 }] })
          }
          onRemove={(id) => setSite({ notes: site.notes.filter((n) => n.id !== id) })}
          render={(id) => {
            const n = site.notes.find((x) => x.id === id)!
            const upd = (p: Partial<typeof n>) =>
              setSite({ notes: site.notes.map((x) => (x.id === id ? { ...x, ...p } : x)) })
            return (
              <>
                <input
                  className="flex-1 min-w-0 px-2 py-1 text-sm border rounded"
                  placeholder="例: 54-11"
                  value={n.label}
                  onChange={(e) => upd({ label: e.target.value })}
                />
                <input
                  type="number"
                  step="0.001"
                  className="w-20 px-1 py-1 text-xs border rounded text-right font-mono"
                  title="東 (Y)"
                  value={n.x}
                  onChange={(e) => upd({ x: readNum(e.target.value) })}
                />
                <input
                  type="number"
                  step="0.001"
                  className="w-20 px-1 py-1 text-xs border rounded text-right font-mono"
                  title="北 (X)"
                  value={n.y}
                  onChange={(e) => upd({ y: readNum(e.target.value) })}
                />
              </>
            )
          }}
        />

        <ListEditor
          title="敷地境界からの離れ"
          empty="例: 北側境界まで 1.20 のように、図面に記入する寸法を足します。"
          ids={site.refDistances.map((d) => d.id)}
          onAdd={() =>
            setSite({
              refDistances: [...site.refDistances, { id: newId(), label: '', value: 0 }],
            })
          }
          onRemove={(id) =>
            setSite({ refDistances: site.refDistances.filter((d) => d.id !== id) })
          }
          render={(id) => {
            const d = site.refDistances.find((x) => x.id === id)!
            const upd = (p: Partial<typeof d>) =>
              setSite({
                refDistances: site.refDistances.map((x) => (x.id === id ? { ...x, ...p } : x)),
              })
            return (
              <>
                <input
                  className="flex-1 min-w-0 px-2 py-1 text-sm border rounded"
                  placeholder="例: 北側境界まで"
                  value={d.label}
                  onChange={(e) => upd({ label: e.target.value })}
                />
                <input
                  type="number"
                  step="0.01"
                  className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
                  value={d.value}
                  onChange={(e) => upd({ value: readNum(e.target.value) })}
                />
              </>
            )
          }}
        />
      </div>

      <div className="flex-1 min-w-0 border rounded bg-white p-2">
        <SitePlanPreview
          sitePoints={sitePoints}
          outline={ground?.outline ?? []}
          offsetE={site.offsetE}
          offsetN={site.offsetN}
          rotationDeg={site.rotationDeg}
          notes={site.notes}
          northAngleDeg={site.northAngleDeg}
          className="w-full h-full"
        />
      </div>
    </div>
  )
}

/** 「表題 + 追加ボタン + 行」 の 繰り返し を まとめる */
function ListEditor({
  title,
  empty,
  ids,
  onAdd,
  onRemove,
  render,
}: {
  title: string
  empty: string
  ids: string[]
  onAdd: () => void
  onRemove: (id: string) => void
  render: (id: string) => React.ReactNode
}) {
  return (
    <div className="pt-3 mt-3 border-t">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-slate-500">{title}</div>
        <button
          type="button"
          onClick={onAdd}
          className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          追加
        </button>
      </div>
      {ids.length === 0 ? (
        <div className="text-[11px] text-slate-400">{empty}</div>
      ) : (
        <ul className="space-y-1">
          {ids.map((id) => (
            <li key={id} className="flex items-center gap-1">
              {render(id)}
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="p-1 text-slate-400 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ========================================================================
// 4. 図枠要素
// ========================================================================
export function StepFrame({
  plan,
  parcels,
  onPatch,
}: {
  plan: FloorPlan
  parcels: WorkAreaRow[]
  onPatch: Patch
}) {
  const frame = plan.frame
  const setFrame = (p: Partial<FloorPlanFrame>) => onPatch({ frame: { ...frame, ...p } })

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[24rem] shrink-0 overflow-auto space-y-1">
        <Field label="用紙">
          <div className="px-2 py-1 text-sm text-slate-600 bg-slate-100 rounded inline-block">
            B4 横（364 × 257 mm）
          </div>
        </Field>
        <Field label="縮尺" hint="各階平面図は 1/250、建物図面は 1/500 が原則です。">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 w-16">各階平面図</span>
            <span className="text-sm text-slate-600">1 /</span>
            <input
              type="number"
              className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
              value={plan.plan_scale}
              onChange={(e) => onPatch({ plan_scale: Math.max(1, readNum(e.target.value)) })}
            />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-slate-500 w-16">建物図面</span>
            <span className="text-sm text-slate-600">1 /</span>
            <input
              type="number"
              className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
              value={plan.site_scale}
              onChange={(e) => onPatch({ site_scale: Math.max(1, readNum(e.target.value)) })}
            />
          </div>
        </Field>

        <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">作製者</div>
        <Field label="作製年月日" hint="表題欄には「（令和5年11月15日作製）」と出ます。">
          <input
            type="date"
            className={inputCls}
            value={frame.createdOn ?? ''}
            onChange={(e) => setFrame({ createdOn: e.target.value || null })}
          />
        </Field>
        <Field label="住所">
          <input
            className={inputCls}
            value={frame.makerAddress}
            onChange={(e) => setFrame({ makerAddress: e.target.value })}
            placeholder="例: 斜里郡斜里町青葉町9番地13"
          />
        </Field>
        <Field label="資格">
          <input
            className={inputCls}
            value={frame.makerQualification}
            onChange={(e) => setFrame({ makerQualification: e.target.value })}
          />
        </Field>
        <Field label="氏名">
          <input
            className={inputCls}
            value={frame.makerName}
            onChange={(e) => setFrame({ makerName: e.target.value })}
          />
        </Field>

        <div className="pt-2 mt-2 border-t text-xs font-semibold text-slate-500">申請人</div>
        <Field label="氏名">
          <input
            className={inputCls}
            value={frame.applicantName}
            onChange={(e) => setFrame({ applicantName: e.target.value })}
          />
        </Field>

        <div className="pt-2 mt-2 border-t" />
        <Field label="備考">
          <textarea
            className={`${inputCls} h-16`}
            value={frame.remarks}
            onChange={(e) => setFrame({ remarks: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="text-xs font-semibold text-slate-500 mb-1">用紙の下絵（B4 横）</div>
        <div className="flex-1 min-h-0 border rounded bg-slate-100 p-3 overflow-auto">
          <SheetPreview plan={plan} parcels={parcels} />
        </div>
        <div className="mt-1 text-[11px] text-slate-400">
          最終成果（p21 / tif / pdf）の出力はこの後の実装です。
        </div>
      </div>
    </div>
  )
}


// ========================================================================
// B4 の 用紙
// ========================================================================

/**
 * 枠線 の 位置 (mm)。 doc/tatemono1.tif (400dpi / 5732 × 4047 px) の 罫線 を
 * 実測 した もの。 px × 25.4 / 400 で mm に 直して いる。
 *
 *   上 は 段違い。 左半分 (各階平面図) が y=19.9、右半分 (建物図面) が y=24.9。
 *   その 段差 の 中 に 家屋番号 の 枡 が 収まる。
 *   表題欄 は 左右 2 つ の 箱 に 分かれ、間 (156.9〜206.9) は 空き。
 */
const SHEET = {
  w: 364,
  h: 257,
  left: 25.0,
  right: 340.9,
  /** 左半分 の 上辺 */
  topLeft: 19.9,
  /** 用紙 の 中心。 左右 の 境 は 線 では なく 上下 の 短い 印 で 示す */
  centerX: 182.0,
  /** 中心 の 印 の 長さ (上 は 上辺 から 下 へ、下 は 表題欄 の 上辺 から 上 へ) */
  centerTick: 8.1,
  /** 家屋番号 の 枡 の 左辺 */
  midX: 191.0,
  /** 家屋番号 の 枡 */
  hnTop: 9.8,
  hnRight: 266.1,
  /** 家屋番号 の 下辺 = 右半分 の 上辺 */
  hnBottom: 24.9,
  /** 建物の所在 の 行 の 下辺 */
  locBottom: 34.9,
  /** 表題欄 の 上辺 */
  bodyBottom: 219.8,
  /** 用紙 の 一番下 の 罫線 */
  titleBottom: 239.9,
  /** 表題欄 左 の 箱: 見出し | 中身 | 縮尺見出し | 縮尺値 */
  tlLeft: [25.0, 33.9, 128.0, 136.0, 156.9],
  /** 表題欄 右 の 箱 */
  tlRight: [206.9, 215.9, 310.9, 319.9, 340.9],
} as const

/** 罫線 の 太さ。 実物 は 400dpi で 2px (= 0.13mm) だが 画面 では 細すぎる */
const LW = 0.25

/** 字間 を 空けた 見出し。 実物 の 「各 階 平 面 図」 の 置き方 に 合わせる */
function SpacedText({
  text,
  x,
  y,
  pitch,
  size,
  fill = '#0f172a',
}: {
  text: string
  x: number
  y: number
  pitch: number
  size: number
  fill?: string
}) {
  return (
    <>
      {Array.from(text).map((c, i) => (
        <text key={i} x={x + pitch * i} y={y} fontSize={size} fill={fill}>
          {c}
        </text>
      ))}
    </>
  )
}

/** 縦書き の 見出し (作製者 / 申請人 / 縮尺) */
function VerticalText({
  text,
  cx,
  top,
  bottom,
  size,
}: {
  text: string
  cx: number
  top: number
  bottom: number
  size: number
}) {
  const n = Array.from(text).length
  const step = (bottom - top) / n
  return (
    <>
      {Array.from(text).map((c, i) => (
        <text
          key={i}
          x={cx}
          y={top + step * (i + 0.5) + size * 0.36}
          fontSize={size}
          textAnchor="middle"
          fill="#0f172a"
        >
          {c}
        </text>
      ))}
    </>
  )
}

/** 表題欄 の 縮尺 欄。 「1／」 が 小さく 上、分母 が 大きく 下 */
function ScaleCell({ x0, x1, scale }: { x0: number; x1: number; scale: number }) {
  return (
    <>
      <text x={x0 + 2.3} y={SHEET.bodyBottom + 11.2} fontSize={2.6} fill="#0f172a">
        1／
      </text>
      <text x={x1 - 3.9} y={SHEET.bodyBottom + 15.1} fontSize={4.6} textAnchor="end" fill="#0f172a">
        {scale}
      </text>
    </>
  )
}

/**
 * B4 横 (364 × 257 mm) の 用紙。 罫線 は SHEET の 実測値 の とおり に 引く。
 * 左 に 各階平面図、右 に 建物図面、下 に 表題欄。
 */
export function SheetPreview({
  plan,
  parcels,
}: {
  plan: FloorPlan
  parcels: WorkAreaRow[]
}) {
  const S = SHEET
  const figures = sortFigures(plan.figures)
  const ground = groundFigure(plan.figures)

  const parcel = parcels.find((p) => p.id === plan.parcel_id) ?? null
  const src = parcel
    ? parcel.confirmedPoints.length > 0
      ? parcel.confirmedPoints
      : parcel.points
    : []
  const sitePoints = src.map((p) => ({ id: p.id, pointNumber: p.pointNumber, x: p.x, y: p.y }))

  // 図形 を 置く 領域 (左半分)
  const planArea = {
    x: S.left,
    y: S.topLeft,
    w: S.centerX - S.left,
    h: S.bodyBottom - S.topLeft,
  }
  // 建物図面 を 置く 領域 (右半分)
  const siteArea = {
    x: S.centerX,
    y: S.locBottom,
    w: S.right - S.centerX,
    h: S.bodyBottom - S.locBottom,
  }

  const [tlA, tlB, tlC, tlD, tlE] = S.tlLeft
  const [trA, trB, trC, trD, trE] = S.tlRight

  return (
    <svg
      viewBox={`0 0 ${S.w} ${S.h}`}
      className="w-full h-auto bg-white shadow"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={0} y={0} width={S.w} height={S.h} fill="#fff" />

      <g stroke="#0f172a" strokeWidth={LW} fill="none" strokeLinecap="square">
        {/* 本体 の 枠。 上辺 は 左右 で 段違い */}
        <line x1={S.left} y1={S.topLeft} x2={S.midX} y2={S.topLeft} />
        <line x1={S.left} y1={S.topLeft} x2={S.left} y2={S.titleBottom} />
        <line x1={S.right} y1={S.hnBottom} x2={S.right} y2={S.titleBottom} />
        <line x1={S.left} y1={S.bodyBottom} x2={S.right} y2={S.bodyBottom} />

        {/* 用紙 中心 の 合わせ印 */}
        <line x1={S.centerX} y1={S.topLeft} x2={S.centerX} y2={S.topLeft + S.centerTick} />
        <line
          x1={S.centerX}
          y1={S.bodyBottom - S.centerTick}
          x2={S.centerX}
          y2={S.bodyBottom}
        />

        {/* 家屋番号 の 枡 と 建物の所在 の 行 */}
        <line x1={S.midX} y1={S.hnTop} x2={S.hnRight} y2={S.hnTop} />
        <line x1={S.midX} y1={S.hnTop} x2={S.midX} y2={S.locBottom} />
        <line x1={S.hnRight} y1={S.hnTop} x2={S.hnRight} y2={S.hnBottom} />
        <line x1={S.midX} y1={S.hnBottom} x2={S.right} y2={S.hnBottom} />
        <line x1={S.midX} y1={S.locBottom} x2={S.right} y2={S.locBottom} />

        {/* 表題欄 左 の 箱 */}
        <line x1={tlA} y1={S.titleBottom} x2={tlE} y2={S.titleBottom} />
        {[tlA, tlB, tlC, tlD, tlE].map((x) => (
          <line key={`l${x}`} x1={x} y1={S.bodyBottom} x2={x} y2={S.titleBottom} />
        ))}
        {/* 表題欄 右 の 箱 */}
        <line x1={trA} y1={S.titleBottom} x2={trE} y2={S.titleBottom} />
        {[trA, trB, trC, trD, trE].map((x) => (
          <line key={`r${x}`} x1={x} y1={S.bodyBottom} x2={x} y2={S.titleBottom} />
        ))}
      </g>

      {/* 用紙 の 見出し。 枠 の 外 に 字間 を 空けて 置く */}
      <SpacedText text="各階平面図" x={80.4} y={17.2} pitch={11.0} size={5.4} />
      <SpacedText text="建物図面" x={280.7} y={21.5} pitch={13.1} size={5.4} />

      {/* 家屋番号 / 建物の所在 */}
      <SpacedText text="家屋番号" x={195.1} y={19.4} pitch={3.9} size={2.8} fill="#0f172a" />
      <text x={232.3} y={19.4} fontSize={3.0} fill="#0f172a">
        {plan.house_number ?? ''}
      </text>
      <SpacedText text="建物の所在" x={195.1} y={30.7} pitch={3.9} size={2.8} fill="#0f172a" />
      <text x={234.0} y={30.7} fontSize={3.0} fill="#0f172a">
        {plan.location ?? ''}
      </text>

      {/* 左: 各階平面図 の 図形 と 求積表 を 2 列 に 並べる */}
      {figures.slice(0, 6).map((f, i) => {
        const cols = 2
        const rows = Math.ceil(Math.min(figures.length, 6) / cols)
        const cw = planArea.w / cols
        const ch = planArea.h / rows
        const cx = planArea.x + cw * (i % cols) + 3
        const cy = planArea.y + ch * Math.floor(i / cols) + 3
        const iw = cw - 6
        const ih = ch * 0.5
        return (
          <g key={f.id}>
            <text x={cx} y={cy + 3} fontSize={3.0} fill="#0f172a">
              {figureLabel(f)}
            </text>
            <svg x={cx} y={cy + 5} width={iw} height={ih}>
              <FigureOutlinePreview
                figure={f}
                underlay={f.id === ground?.id ? null : ground}
                className="w-full h-full"
              />
            </svg>
            <text x={cx + iw / 2} y={cy + ih + 10} fontSize={3.2} fontWeight="bold" textAnchor="middle" fill="#0f172a">
              求積表
            </text>
            {f.terms.slice(0, 5).map((t, j) => (
              <g key={t.id}>
                <text x={cx + 4} y={cy + ih + 15 + j * 3.8} fontSize={2.8} fill="#0f172a">
                  {termFormula(t)}
                </text>
                <text
                  x={cx + iw - 2}
                  y={cy + ih + 15 + j * 3.8}
                  fontSize={2.8}
                  textAnchor="end"
                  fill="#0f172a"
                >
                  = {termValueText(termValue(t))}
                </text>
              </g>
            ))}
            {f.terms.length > 1 && (
              <>
                <line
                  x1={cx + 4}
                  y1={cy + ih + 16.5 + Math.min(f.terms.length, 5) * 3.8}
                  x2={cx + iw - 2}
                  y2={cy + ih + 16.5 + Math.min(f.terms.length, 5) * 3.8}
                  stroke="#0f172a"
                  strokeWidth={LW}
                />
                <text
                  x={cx + iw - 24}
                  y={cy + ih + 20.5 + Math.min(f.terms.length, 5) * 3.8}
                  fontSize={2.8}
                  textAnchor="end"
                  fill="#0f172a"
                >
                  計
                </text>
                <text
                  x={cx + iw - 2}
                  y={cy + ih + 20.5 + Math.min(f.terms.length, 5) * 3.8}
                  fontSize={2.8}
                  textAnchor="end"
                  fill="#0f172a"
                >
                  {termValueText(figureSum(f))}
                </text>
              </>
            )}
            <text
              x={cx + iw - 24}
              y={cy + ih + 25 + Math.min(f.terms.length, 5) * 3.8}
              fontSize={2.8}
              textAnchor="end"
              fill="#0f172a"
            >
              床面積
            </text>
            <text
              x={cx + iw - 2}
              y={cy + ih + 25 + Math.min(f.terms.length, 5) * 3.8}
              fontSize={2.8}
              textAnchor="end"
              fill="#0f172a"
            >
              {floorAreaText(figureFloorArea(f))} ㎡
            </text>
          </g>
        )
      })}

      {/* 右: 建物図面 */}
      <svg x={siteArea.x + 4} y={siteArea.y + 4} width={siteArea.w - 8} height={siteArea.h - 8}>
        <SitePlanPreview
          sitePoints={sitePoints}
          outline={ground?.outline ?? []}
          offsetE={plan.site.offsetE}
          offsetN={plan.site.offsetN}
          rotationDeg={plan.site.rotationDeg}
          notes={plan.site.notes}
          northAngleDeg={plan.site.northAngleDeg}
          className="w-full h-full"
        />
      </svg>

      {/* 表題欄 左: 作製者 */}
      <VerticalText text="作製者" cx={(tlA + tlB) / 2} top={S.bodyBottom + 2.8} bottom={S.titleBottom - 3.3} size={3.1} />
      <text x={38.7} y={225.1} fontSize={2.3} fill="#0f172a">
        {warekiCreatedText(plan.frame.createdOn)}
      </text>
      <text x={(tlB + tlC) / 2} y={229.7} fontSize={2.1} textAnchor="middle" fill="#0f172a">
        {plan.frame.makerAddress}
      </text>
      {/* 資格 は 2 行 に 折る (実物 が 「土地家屋 / 調査士」) */}
      <text x={40.4} y={232.3} fontSize={1.8} fill="#0f172a">
        {plan.frame.makerQualification.slice(0, 4)}
      </text>
      <text x={40.4} y={234.6} fontSize={1.8} fill="#0f172a">
        {plan.frame.makerQualification.slice(4)}
      </text>
      <SpacedText
        text={plan.frame.makerName}
        x={61.1}
        y={236.5}
        pitch={plan.frame.makerName.length > 0 ? 48.5 / Math.max(Array.from(plan.frame.makerName).length, 1) : 0}
        size={3.8}
      />
      <VerticalText text="縮尺" cx={(tlC + tlD) / 2} top={S.bodyBottom + 3.4} bottom={S.titleBottom - 4.0} size={2.8} />
      <ScaleCell x0={tlD} x1={tlE} scale={plan.plan_scale} />

      {/* 表題欄 右: 申請人 */}
      <VerticalText text="申請人" cx={(trA + trB) / 2} top={S.bodyBottom + 2.8} bottom={S.titleBottom - 3.3} size={3.1} />
      <text
        x={(trB + trC) / 2}
        y={232.2}
        fontSize={4.5}
        textAnchor="middle"
        letterSpacing={1.6}
        fill="#0f172a"
      >
        {plan.frame.applicantName}
      </text>
      <VerticalText text="縮尺" cx={(trC + trD) / 2} top={S.bodyBottom + 3.4} bottom={S.titleBottom - 4.0} size={2.8} />
      <ScaleCell x0={trD} x1={trE} scale={plan.site_scale} />
    </svg>
  )
}
