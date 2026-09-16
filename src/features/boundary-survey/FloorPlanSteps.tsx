// 建物図面・各階平面図 の 作成手順 (1〜4) の 中身。
//
//   1 建物情報   … 所在 / 地番 / 家屋番号
//   2 階層・形状 … 図形 (主である建物 の 各階 / 附属建物) の 多角形 と 求積表
//   3 配置       … 用紙 右半分 の 建物図面 (敷地 に 載せる)
//   4 図枠       … 表題欄 と 縮尺、 B4 の 下絵
//
// どの 段 も 「左 に 表題 / 右 に 入力欄」 に 揃える。

import { useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import {
  PLACEMENT_METHOD_LABEL,
  TERM_KIND_LABEL,
  closureOf,
  figureFloorArea,
  figureOutline,
  figureLabel,
  figureSum,
  floorAreaText,
  groundFigure,
  newFigure,
  newId,
  newTerm,
  moveLength,
  outlineSummary,
  polygonArea,
  sortFigures,
  termFormula,
  termValue,
  termValueText,
  MAKER_QUALIFICATION,
  totalMainArea,
  warekiCreatedText,
  type AreaTerm,
  type FloorFigure,
  type FloorPlan,
  type FloorPlanFrame,
  type Move,
  type ParcelOption,
  type PlacementMethod,
  type SitePlan,
  type TermKind,
} from './floorPlanTypes'
import { FigureOutlinePreview, SitePlanPreview } from './FloorPlanPreview'
import {
  centerOn,
  ringCentroid,
  siteRing,
  solveByParallel,
  solveByPoints,
} from './floorPlanPlace'

const round3 = (v: number) => Math.round(v * 1000) / 1000
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

/**
 * 数値 の 入力欄。
 *
 * type="number" に パース 済み の 数値 を そのまま 流す と、「3.」 と 打った 時点 で
 * Number('3.') = 3 に 丸められ 小数点 が 消える。 空 に すれば 0 が 入る。
 * それ を 避ける ため、触って いる 間 は 打った 文字列 を そのまま 持ち、
 * 離れた ときに 保存値 の 表示 へ 戻す。
 */
function NumField({
  value,
  onChange,
  className = numCls,
  placeholder,
  title,
  disabled,
  dataCell,
  onKeyDown,
}: {
  /** null なら 空欄 (まだ 入れて いない 行) */
  value: number | null
  onChange: (v: number) => void
  className?: string
  placeholder?: string
  title?: string
  disabled?: boolean
  dataCell?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      data-cell={dataCell}
      onKeyDown={onKeyDown}
      value={text ?? (value == null ? '' : String(value))}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        if (t.trim() === '') {
          onChange(0)
          return
        }
        const n = Number(t)
        if (Number.isFinite(n)) onChange(n)
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setText(null)}
    />
  )
}

// ========================================================================
// 1. 建物情報
// ========================================================================
export function StepBuilding({
  plan,
  parcels,
  onSelectParcel,
  onPatch,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  onSelectParcel: (workAreaId: string) => void
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
          <NumField
            value={plan.sheet_no}
            onChange={(v) => onPatch({ sheet_no: Math.max(1, v) })}
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
            <ParcelSelect plan={plan} parcels={parcels} onSelectParcel={onSelectParcel} />
          </Field>
        </>
      )}
    </div>
  )
}

/**
 * 地番 の プルダウン。
 * 表示 と 選択 は 工事区域 の id で 行い、保存 する のは parcels.id。
 * 地籍属性 の 行 が まだ 無い 地番 は 選んだ 時点 で 親 が 作る。
 */
function ParcelSelect({
  plan,
  parcels,
  onSelectParcel,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  onSelectParcel: (workAreaId: string) => void
}) {
  const current = parcels.find((p) => p.parcelId != null && p.parcelId === plan.parcel_id)
  return (
    <select
      className={inputCls}
      value={current?.workAreaId ?? ''}
      onChange={(e) => onSelectParcel(e.target.value)}
    >
      <option value="">（紐づけない）</option>
      {parcels.map((p) => (
        <option key={p.workAreaId} value={p.workAreaId}>
          {p.label}
        </option>
      ))}
    </select>
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
                {outlineSummary(figureOutline(f))} / 床面積 {floorAreaText(figureFloorArea(f))} ㎡
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
  const pts = figureOutline(figure)
  const poly = polygonArea(pts)
  // 求積表 と 図形 が 食い違って いたら 気づける ように
  const mismatch = pts.length >= 3 && Math.abs(poly - sum) > 0.005

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm font-semibold">{figureLabel(figure)}</div>
        <div className="flex items-center gap-1 ml-2">
          <label className="text-xs text-slate-500">階</label>
          <NumField
            value={figure.floorNo}
            onChange={(v) => onChange({ floorNo: Math.trunc(v) || 1 })}
            className="w-16 px-2 py-0.5 text-sm border rounded text-right"
          />
          {figure.kind === 'annex' && (
            <>
              <label className="ml-2 text-xs text-slate-500">符号</label>
              <NumField
                value={figure.annexNo ?? 1}
                onChange={(v) => onChange({ annexNo: Math.trunc(v) || 1 })}
                className="w-16 px-2 py-0.5 text-sm border rounded text-right"
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
            <ShapeEditor figure={figure} onChange={onChange} />
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
            {pts.length >= 3 && (
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

/**
 * 形状: 辺 を 「縦・横 の 相対距離」 で 並べる。
 * 「2, 0」 なら 前 の 点 から 縦 に 2 進む。 図面 の 寸法 が そのまま 入る。
 *
 * 表計算 の ように 一番下 は いつも 空行 に して おき、そこ に 打つ と 1 辺
 * 増える。 Tab は 縦 → 横 → 次 の 行 の 縦 と 流れる (ごみ箱 は 飛ばす)。
 */
function ShapeEditor({
  figure,
  onChange,
}: {
  figure: FloorFigure
  onChange: (p: Partial<FloorFigure>) => void
}) {
  const moves = figure.moves
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)

  const setMoves = (next: Move[]) => onChange({ moves: next })
  /** i 行目 を 直す。 空行 (i === moves.length) に 打たれたら 1 辺 増やす */
  const patch = (i: number, p: Partial<Move>) => {
    if (i >= moves.length) {
      setMoves([...moves, { v: 0, h: 0, ...p }])
      return
    }
    setMoves(moves.map((m, j) => (j === i ? { ...m, ...p } : m)))
  }

  /** Enter で 次 の 欄 へ。 一番下 の 横 なら 行 を 足して その 縦 へ */
  const focusCell = (row: number, col: 'v' | 'h') => {
    window.setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLInputElement>(
        `input[data-cell="${row}-${col}"]`,
      )
      el?.focus()
      el?.select()
    }, 0)
  }

  const closure = closureOf(moves)
  const open = moves.length >= 3 && (Math.abs(closure.v) > 0.0005 || Math.abs(closure.h) > 0.0005)

  // 一番下 は いつも 空行
  const rows: (Move | null)[] = [...moves, null]

  return (
    <div className="flex flex-col min-h-0">
      <div className="border rounded overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium w-8">#</th>
              <th className="px-2 py-1 text-right font-medium">縦</th>
              <th className="px-2 py-1 text-right font-medium">横</th>
              <th className="px-2 py-1 text-right font-medium">辺長</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y" ref={bodyRef}>
            {rows.map((m, i) => (
              <tr key={i} className={m ? '' : 'bg-slate-50/60'}>
                <td className="px-2 py-1 text-xs text-slate-400">{m ? i + 1 : ''}</td>
                <td className="px-2 py-1 text-right">
                  <NumField
                    value={m ? m.v : null}
                    onChange={(v) => patch(i, { v })}
                    dataCell={`${i}-v`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        focusCell(i, 'h')
                      }
                    }}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <NumField
                    value={m ? m.h : null}
                    onChange={(h) => patch(i, { h })}
                    dataCell={`${i}-h`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        focusCell(i + 1, 'v')
                      }
                    }}
                  />
                </td>
                <td className="px-2 py-1 text-right font-mono text-xs text-slate-600">
                  {m ? moveLength(m).toFixed(3) : ''}
                </td>
                <td className="px-1">
                  {m && (
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setMoves(moves.filter((_, j) => j !== i))}
                      className="p-0.5 text-slate-400 hover:text-red-600"
                      title="この辺を削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-1 text-[11px] text-slate-400">
        前の点からの距離。上・右が正、下・左は負の数で入れます。一番下の空行に打つと辺が増えます。
      </div>

      {open && (
        <div className="mt-1 px-2 py-1 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
          形が閉じていません（閉合差 縦 {closure.v.toFixed(3)} / 横 {closure.h.toFixed(3)}）。
          最後の辺で始点に戻るように入れてください。
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-slate-500">1階からのずれ</span>
        <span className="text-slate-400">縦</span>
        <NumField
          value={figure.offset.y}
          onChange={(v) => onChange({ offset: { ...figure.offset, y: v } })}
        />
        <span className="text-slate-400">横</span>
        <NumField
          value={figure.offset.x}
          onChange={(v) => onChange({ offset: { ...figure.offset, x: v } })}
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
                      <NumField
                        value={t.manual}
                        onChange={(v) => patch(i, { manual: v })}
                        className="w-24 px-1 py-0.5 text-xs border rounded text-right font-mono"
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-1 py-1 text-right">
                      <NumField
                        value={t.a}
                        onChange={(v) => patch(i, { a: v })}
                        className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      <NumField
                        value={t.b}
                        onChange={(v) => patch(i, { b: v })}
                        className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
                      />
                    </td>
                    <td className="px-1 py-1 text-right">
                      {t.kind === 'trapezoid' ? (
                        <NumField
                          value={t.h}
                          onChange={(v) => patch(i, { h: v })}
                          className="w-20 px-1 py-0.5 text-xs border rounded text-right font-mono"
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

/** 境界線 の 見出し 「① 点1→点2」 */
function edgeLabel(points: { pointNumber: string }[], i: number): string {
  if (points.length < 2) return `境界線 ${i + 1}`
  const a = points[i % points.length]
  const b = points[(i + 1) % points.length]
  return `${i + 1}: ${a?.pointNumber ?? '?'} → ${b?.pointNumber ?? '?'}`
}

export function StepSite({
  plan,
  parcels,
  onSelectParcel,
  onPatch,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  onSelectParcel: (workAreaId: string) => void
  onPatch: Patch
}) {
  const site = plan.site
  const setSite = (p: Partial<SitePlan>) => onPatch({ site: { ...site, ...p } })

  const parcel = parcels.find((p) => p.parcelId != null && p.parcelId === plan.parcel_id) ?? null
  // 毎回 新しい 配列 に なる と useMemo が 効かない ので 一度 で 束ねる
  const sitePoints = useMemo(() => parcel?.points ?? [], [parcel])
  const ring = useMemo(() => siteRing(sitePoints), [sitePoints])

  const ground = groundFigure(plan.figures)
  const moves = ground?.moves ?? []
  const outline = useMemo(() => (ground ? figureOutline(ground) : []), [ground])

  const ready = ring.length >= 3 && moves.length >= 3
  const [note, setNote] = useState<string | null>(null)

  /** 出た 配置 を 書き戻す */
  const apply = (pl: { offsetE: number; offsetN: number; rotationDeg: number } | null, msg: string) => {
    if (!pl) {
      setNote('計算できませんでした。選んだ辺と境界線を見直してください。')
      return
    }
    setSite({ ...pl, placed: true })
    setNote(msg)
  }

  const runThreePoint = () => {
    const start =
      site.offsetE === 0 && site.offsetN === 0
        ? centerOn(moves, ring, site.rotationDeg)
        : { offsetE: site.offsetE, offsetN: site.offsetN, rotationDeg: site.rotationDeg }
    const r = solveByPoints(moves, ring, site.constraints, start)
    if (!r) {
      setNote('計算できませんでした。3 行とも入れてください。')
      return
    }
    apply(
      r.placement,
      r.residual > 0.005
        ? `配置しました。ただし指定と ${r.residual.toFixed(3)} m ずれています（条件が矛盾しているかもしれません）。`
        : '配置しました。',
    )
  }

  const runParallel = () => {
    const spec = site.parallel ?? { buildingEdge: 0, siteEdge: 0, offset: 0, along: 0, flip: false }
    apply(solveByParallel(moves, ring, spec), '配置しました。')
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[22rem] shrink-0 overflow-auto">
        <Field label="敷地の地番">
          <ParcelSelect plan={plan} parcels={parcels} onSelectParcel={onSelectParcel} />
        </Field>

        {ready && !site.placed && (
          <div className="my-2 px-2 py-1.5 rounded bg-blue-50 border border-blue-200 text-[11px] text-blue-800">
            まだ建物を据えていないので、図には敷地だけを出しています。下の方法で配置すると建物が現れます。
          </div>
        )}

        {parcel && sitePoints.length === 0 && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            この地番にはまだ構成点がありません。地番管理で構成点を登録してください。
          </div>
        )}
        {!ground && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            「2 階層・形状寸法」で 主である建物1階 の形状を入れてください。
          </div>
        )}

        <Field label="配置方法">
          <select
            className={inputCls}
            value={site.method}
            onChange={(e) => setSite({ method: e.target.value as PlacementMethod })}
          >
            {(Object.keys(PLACEMENT_METHOD_LABEL) as PlacementMethod[]).map((k) => (
              <option key={k} value={k}>
                {PLACEMENT_METHOD_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>

        {site.method === 'three_point' && (
          <div className="pt-2 mt-2 border-t">
            <div className="text-[11px] text-slate-500 mb-1">
              建物の角を 3 つ選び、それぞれが境界線から内側へ何 m 離れているかを入れます。
            </div>
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left font-medium py-1">建物の角</th>
                  <th className="text-left font-medium py-1">境界線</th>
                  <th className="text-right font-medium py-1">離れ</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {site.constraints.map((c, i) => (
                  <tr key={c.id}>
                    <td className="py-0.5 pr-1">
                      <select
                        className="w-full px-1 py-1 text-xs border rounded"
                        value={c.vertexIndex}
                        onChange={(e) =>
                          setSite({
                            constraints: site.constraints.map((x, j) =>
                              j === i ? { ...x, vertexIndex: Number(e.target.value) } : x,
                            ),
                          })
                        }
                      >
                        {outline.map((_, k) => (
                          <option key={k} value={k}>
                            角 {k + 1}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-0.5 pr-1">
                      <select
                        className="w-full px-1 py-1 text-xs border rounded"
                        value={c.edgeIndex}
                        onChange={(e) =>
                          setSite({
                            constraints: site.constraints.map((x, j) =>
                              j === i ? { ...x, edgeIndex: Number(e.target.value) } : x,
                            ),
                          })
                        }
                      >
                        {sitePoints.map((_, k) => (
                          <option key={k} value={k}>
                            {edgeLabel(sitePoints, k)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-0.5">
                      <NumField
                        value={c.distance}
                        onChange={(v) =>
                          setSite({
                            constraints: site.constraints.map((x, j) =>
                              j === i ? { ...x, distance: v } : x,
                            ),
                          })
                        }
                        className="w-16 px-1 py-1 text-xs border rounded text-right font-mono"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          setSite({ constraints: site.constraints.filter((_, j) => j !== i) })
                        }
                        className="p-0.5 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setSite({
                    constraints: [
                      ...site.constraints,
                      { id: newId(), vertexIndex: 0, edgeIndex: 0, distance: 0 },
                    ],
                  })
                }
                className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                行を追加
              </button>
              <button
                type="button"
                onClick={runThreePoint}
                disabled={!ready || site.constraints.length < 3}
                className="px-3 py-0.5 text-xs border rounded bg-blue-600 text-white border-blue-600 disabled:opacity-40 hover:bg-blue-700"
              >
                配置を計算
              </button>
            </div>
            {site.constraints.length > 0 && site.constraints.length < 3 && (
              <div className="mt-1 text-[11px] text-slate-400">
                3 行そろうと向きまで決まります。
              </div>
            )}
          </div>
        )}

        {site.method === 'parallel' && (
          <ParallelFields
            site={site}
            moves={moves}
            sitePoints={sitePoints}
            ready={ready}
            onChange={(p) => setSite({ parallel: p })}
            onRun={runParallel}
          />
        )}

        {site.method === 'manual' && (
          <div className="pt-2 mt-2 border-t">
            <Field label="東方向 (Y)">
              <NumField
                value={site.offsetE}
                onChange={(v) => setSite({ offsetE: v, placed: true })}
              />
            </Field>
            <Field label="北方向 (X)">
              <NumField
                value={site.offsetN}
                onChange={(v) => setSite({ offsetN: v, placed: true })}
              />
            </Field>
            <Field label="建物の向き">
              <div className="flex items-center gap-1">
                <NumField
                  value={site.rotationDeg}
                  onChange={(v) => setSite({ rotationDeg: v, placed: true })}
                />
                <span className="text-xs text-slate-500">度</span>
              </div>
            </Field>
            {ready && (
              <button
                type="button"
                onClick={() => setSite({ ...centerOn(moves, ring, site.rotationDeg), placed: true })}
                className="px-2 py-1 text-xs border rounded hover:bg-slate-50"
              >
                敷地の中心に寄せる
              </button>
            )}
          </div>
        )}

        {note && (
          <div className="mt-2 px-2 py-1.5 rounded bg-slate-100 text-[11px] text-slate-700">
            {note}
          </div>
        )}

        {site.placed && (
          <button
            type="button"
            onClick={() => {
              setSite({ placed: false, offsetE: 0, offsetN: 0, rotationDeg: 0 })
              setNote(null)
            }}
            className="mt-2 px-2 py-1 text-xs border rounded hover:bg-slate-50 text-slate-600"
          >
            配置をやり直す
          </button>
        )}

        <Field label="方位" hint="図面の上を真北から何度振るか。0 なら上が真北。">
          <div className="flex items-center gap-1">
            <NumField value={site.northAngleDeg} onChange={(v) => setSite({ northAngleDeg: v })} />
            <span className="text-xs text-slate-500">度</span>
          </div>
        </Field>

        <ListEditor
          title="隣地の地番など（注記）"
          empty="例: 54-11 / 292 のように、隣接地の地番を図に添えます。"
          ids={site.notes.map((n) => n.id)}
          onAdd={() => {
            // 0,0 に 置く と 敷地 (数十万 m) と の 間 で 縮尺 が 壊れる
            const g = ringCentroid(ring)
            setSite({
              notes: [...site.notes, { id: newId(), label: '', x: round3(g.e), y: round3(g.n) }],
            })
          }}
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
                <NumField
                  value={n.x}
                  onChange={(v) => upd({ x: v })}
                  className="w-20 px-1 py-1 text-xs border rounded text-right font-mono"
                  title="東 (Y)"
                />
                <NumField
                  value={n.y}
                  onChange={(v) => upd({ y: v })}
                  className="w-20 px-1 py-1 text-xs border rounded text-right font-mono"
                  title="北 (X)"
                />
              </>
            )
          }}
        />

        <ListEditor
          title="敷地境界からの離れ（図面に記入する寸法）"
          empty="例: 北側境界まで 1.20 のように、図面に記入する寸法を足します。"
          ids={site.refDistances.map((d) => d.id)}
          onAdd={() =>
            setSite({ refDistances: [...site.refDistances, { id: newId(), label: '', value: 0 }] })
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
                <NumField
                  value={d.value}
                  onChange={(v) => upd({ value: v })}
                  className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
                />
              </>
            )
          }}
        />
      </div>

      <div className="flex-1 min-w-0 border rounded bg-white p-2">
        <SitePlanPreview
          sitePoints={sitePoints}
          outline={outline}
          offsetE={site.offsetE}
          offsetN={site.offsetN}
          rotationDeg={site.rotationDeg}
          notes={site.notes}
          northAngleDeg={site.northAngleDeg}
          showBuilding={site.placed}
          interactive
          className="w-full h-full"
        />
      </div>
    </div>
  )
}

/** 1 辺平行 の 入力 */
function ParallelFields({
  site,
  moves,
  sitePoints,
  ready,
  onChange,
  onRun,
}: {
  site: SitePlan
  moves: Move[]
  sitePoints: { pointNumber: string }[]
  ready: boolean
  onChange: (p: NonNullable<SitePlan['parallel']>) => void
  onRun: () => void
}) {
  const p = site.parallel ?? {
    buildingEdge: 0,
    siteEdge: 0,
    offset: 0,
    along: 0,
    flip: false,
  }
  return (
    <div className="pt-2 mt-2 border-t">
      <div className="text-[11px] text-slate-500 mb-1">
        建物の 1 辺を境界線に平行にして据えます。離れと沿いの距離で位置が決まります。
      </div>
      <Field label="建物の辺">
        <select
          className={inputCls}
          value={p.buildingEdge}
          onChange={(e) => onChange({ ...p, buildingEdge: Number(e.target.value) })}
        >
          {moves.map((m, i) => (
            <option key={i} value={i}>
              辺 {i + 1}（{moveLength(m).toFixed(3)} m）
            </option>
          ))}
        </select>
      </Field>
      <Field label="平行にする境界線">
        <select
          className={inputCls}
          value={p.siteEdge}
          onChange={(e) => onChange({ ...p, siteEdge: Number(e.target.value) })}
        >
          {sitePoints.map((_, k) => (
            <option key={k} value={k}>
              {edgeLabel(sitePoints, k)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="離れ" hint="境界線から内側へ何 m 離すか。">
        <NumField value={p.offset} onChange={(v) => onChange({ ...p, offset: v })} />
      </Field>
      <Field label="沿い" hint="境界線の始点から、線に沿って何 m の位置に辺の始点を置くか。">
        <NumField value={p.along} onChange={(v) => onChange({ ...p, along: v })} />
      </Field>
      <Field label="向き">
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={p.flip}
            onChange={(e) => onChange({ ...p, flip: e.target.checked })}
          />
          180 度返す（建物が境界の外に出たとき）
        </label>
      </Field>
      <button
        type="button"
        onClick={onRun}
        disabled={!ready}
        className="mt-1 px-3 py-1 text-xs border rounded bg-blue-600 text-white border-blue-600 disabled:opacity-40 hover:bg-blue-700"
      >
        配置を計算
      </button>
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
  parcels: ParcelOption[]
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
            <NumField
              value={plan.plan_scale}
              onChange={(v) => onPatch({ plan_scale: Math.max(1, v) })}
              className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
            />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-slate-500 w-16">建物図面</span>
            <span className="text-sm text-slate-600">1 /</span>
            <NumField
              value={plan.site_scale}
              onChange={(v) => onPatch({ site_scale: Math.max(1, v) })}
              className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
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
        <Field
          label="法人名"
          hint="土地家屋調査士法人のときだけ入れます。氏名の上に出ます。個人なら空のまま。"
        >
          <input
            className={inputCls}
            value={frame.makerCorporation}
            onChange={(e) => setFrame({ makerCorporation: e.target.value })}
            placeholder="例: 土地家屋調査士法人〇〇"
          />
        </Field>
        <Field label="氏名" hint="資格「土地家屋調査士」は様式で固定のため入力は不要です。">
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
  /** 「家屋番号」「建物の所在」 の 見出し と 値 を 分ける 縦罫 */
  hnLabelRight: 232.6,
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

/**
 * 表題欄 左 の 作製者 の 中身。
 * 個人 なら 住所 → 資格 + 氏名 の 2 段。
 * 土地家屋調査士法人 なら その 名称 を 氏名 の 上 に 挟んで 3 段 に する。
 */
function MakerBlock({
  frame,
  x0,
  x1,
}: {
  frame: FloorPlanFrame
  x0: number
  x1: number
}) {
  const corp = frame.makerCorporation.trim()
  const cx = (x0 + x1) / 2
  // 行 の 高さ を 詰めて 3 段 を 収める
  const yAddress = corp ? 228.8 : 229.7
  const yCorp = 232.6
  const yName = corp ? 237.6 : 236.5
  const nameChars = Math.max(Array.from(frame.makerName).length, 1)
  return (
    <>
      <text x={cx} y={yAddress} fontSize={2.1} textAnchor="middle" fill="#0f172a">
        {frame.makerAddress}
      </text>
      {corp && (
        <text x={cx} y={yCorp} fontSize={2.6} textAnchor="middle" fill="#0f172a">
          {corp}
        </text>
      )}
      {/* 資格 は この 様式 では 固定。 実物 と 同じ く 2 行 に 折る */}
      <text x={x0 + 6.5} y={yName - 4.2} fontSize={1.8} fill="#0f172a">
        {MAKER_QUALIFICATION.slice(0, 4)}
      </text>
      <text x={x0 + 6.5} y={yName - 1.9} fontSize={1.8} fill="#0f172a">
        {MAKER_QUALIFICATION.slice(4)}
      </text>
      <SpacedText
        text={frame.makerName}
        x={x0 + 27.2}
        y={yName}
        pitch={48.5 / nameChars}
        size={3.8}
      />
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
  parcels: ParcelOption[]
}) {
  const S = SHEET
  const figures = sortFigures(plan.figures)
  const ground = groundFigure(plan.figures)

  const parcel = parcels.find((p) => p.parcelId != null && p.parcelId === plan.parcel_id) ?? null
  const sitePoints = parcel?.points ?? []

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
        <line x1={S.hnLabelRight} y1={S.hnTop} x2={S.hnLabelRight} y2={S.locBottom} />
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
      <SpacedText text="家屋番号" x={195.1} y={19.4} pitch={11.0} size={2.8} />
      <text x={234.6} y={19.4} fontSize={3.0} fill="#0f172a">
        {plan.house_number ?? ''}
      </text>
      <SpacedText text="建物の所在" x={195.1} y={30.7} pitch={8.5} size={2.8} />
      <text x={234.6} y={30.7} fontSize={3.0} fill="#0f172a">
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
          outline={ground ? figureOutline(ground) : []}
          offsetE={plan.site.offsetE}
          offsetN={plan.site.offsetN}
          rotationDeg={plan.site.rotationDeg}
          notes={plan.site.notes}
          northAngleDeg={plan.site.northAngleDeg}
          showBuilding={plan.site.placed}
          className="w-full h-full"
        />
      </svg>

      {/* 表題欄 左: 作製者 */}
      <VerticalText text="作製者" cx={(tlA + tlB) / 2} top={S.bodyBottom + 2.8} bottom={S.titleBottom - 3.3} size={3.1} />
      <text x={38.7} y={225.1} fontSize={2.3} fill="#0f172a">
        {warekiCreatedText(plan.frame.createdOn)}
      </text>
      <MakerBlock frame={plan.frame} x0={tlB} x1={tlC} />
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
