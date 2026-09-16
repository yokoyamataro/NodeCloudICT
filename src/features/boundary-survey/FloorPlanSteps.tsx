// 建物図面・各階平面図 の 作成手順 (1〜4) の 中身。
//
//   1 建物情報   … 所在 / 地番 / 家屋番号
//   2 階層・形状 … 図形 (主である建物 の 各階 / 附属建物) の 多角形 と 求積表
//   3 配置       … 用紙 右半分 の 建物図面 (敷地 に 載せる)
//   4 図枠       … 表題欄 と 縮尺、 B4 の 下絵
//
// どの 段 も 「左 に 表題 / 右 に 入力欄」 に 揃える。

import { useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Download, Loader2, Plus, Trash2 } from 'lucide-react'
import {
  PLACEMENT_METHOD_LABEL,
  TERM_KIND_LABEL,
  closureOf,
  figureFloorArea,
  figureOutline,
  figureLabel,
  figureSum,
  floorAreaText,
  buildingKeys,
  buildingLabel,
  groundOfBuilding,
  newFigure,
  constraintsOf,
  parallelOf,
  placementOf,
  withConstraints,
  withParallel,
  withPlacement,
  newId,
  newTerm,
  moveLength,
  outlineSummary,
  placeOutline,
  polygonArea,
  termFormula,
  termValue,
  termValueText,
  totalMainArea,
  underlayOf,
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
import { FigureOutlinePreview } from './FloorPlanPreview'
import { SHEET, buildSheet, type LineStyle } from './floorPlanDraw'
import {
  CUT_DIR_LABEL,
  autoSlabs,
  splitByCuts,
  termsFromRegions,
  type AreaCut,
  type CutDir,
} from './floorPlanRegion'
import {
  buildP21,
  canvasToPdf,
  canvasToTiff,
  renderToCanvas,
  safeFileName,
  saveBlob,
} from './floorPlanExport'
import { FloorPlanSiteMap } from './FloorPlanSiteMap'
import type { CoordinateConverter } from '@/lib/coordinates'
import {
  centerOn,
  parallelGuides,
  ringCentroid,
  siteRing,
  solveByParallel,
  solveByPoints,
  type EN,
  type ParallelSpec,
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
  onToggleParcel,
  onPatch,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  onToggleParcel: (workAreaId: string) => void
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
          <Field
            label="敷地の地番"
            hint="複数の土地にまたがる建物は、まとめて選びます。「3 配置」で敷地の外形に使います。"
          >
            <ParcelPickerStandalone
              plan={plan}
              parcels={parcels}
              onToggleParcel={onToggleParcel}
            />
          </Field>
        </>
      )}
    </div>
  )
}

/**
 * 地番 の 選択。 建物 が 複数 の 土地 に またがる こと が ある ので 複数 選べる。
 * 表示 と 選択 は 工事区域 の id で 行い、保存 する のは parcels.id。
 * 地籍属性 の 行 が まだ 無い 地番 は 選んだ 時点 で 親 が 作る。
 */
function ParcelPicker({
  plan,
  parcels,
  open,
  onOpenChange,
  onToggleParcel,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  /** 選択中 か。 この 間 だけ 地図 の 地番 も 押せる */
  open: boolean
  onOpenChange: (v: boolean) => void
  onToggleParcel: (workAreaId: string) => void
}) {
  const chosen = new Set(plan.site.parcelIds)
  const setOpen = onOpenChange
  const picked = parcels.filter((p) => p.parcelId != null && chosen.has(p.parcelId))

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {picked.length === 0 ? (
          <span className="text-xs text-slate-400">未選択</span>
        ) : (
          picked.map((p) => (
            <span
              key={p.workAreaId}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-xs text-emerald-800"
            >
              {p.label}
              <button
                type="button"
                onClick={() => onToggleParcel(p.workAreaId)}
                className="text-emerald-500 hover:text-red-600"
                title="外す"
              >
                ×
              </button>
            </span>
          ))
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`px-2 py-0.5 text-xs border rounded ${
            open
              ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
              : 'hover:bg-slate-50'
          }`}
        >
          {open ? '確定' : '地番を選ぶ'}
        </button>
      </div>
      {open && (
        <>
          <div className="mt-1 text-[11px] text-blue-700">
            地図の地番を押しても付け外しできます。終わったら「確定」。
          </div>
          <ul className="mt-1 max-h-48 overflow-auto border rounded divide-y">
          {parcels.length === 0 && (
            <li className="p-2 text-xs text-slate-400">地番がありません。</li>
          )}
          {parcels.map((p) => {
            const on = p.parcelId != null && chosen.has(p.parcelId)
            return (
              <li key={p.workAreaId}>
                <label className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggleParcel(p.workAreaId)}
                  />
                  <span className="flex-1 min-w-0 truncate">{p.label}</span>
                  <span className="text-[11px] text-slate-400">{p.points.length} 点</span>
                </label>
              </li>
            )
          })}
          </ul>
        </>
      )}
    </div>
  )
}

/** 地図 と 連動 しない 場面 (1 建物情報) 用 の 包み */
function ParcelPickerStandalone(props: {
  plan: FloorPlan
  parcels: ParcelOption[]
  onToggleParcel: (workAreaId: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <ParcelPicker {...props} open={open} onOpenChange={setOpen} />
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
            underlay={underlayOf(figures, active)}
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
  /** 区切り線 の 起点 を 図 から 拾う。 'new' は これから 足す 1 本 */
  const [cutPick, setCutPick] = useState<string | null>(null)
  /** 起点 を 決めた 後、向き を 選んで もらう 折点 */
  const [dirAt, setDirAt] = useState<number | null>(null)
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
            <ShapeEditor figure={figure} hasUnderlay={underlay != null} onChange={onChange} />
          ) : (
            <AreaTable
              figure={figure}
              onChange={onChange}
              cutPick={cutPick}
              onStartCutPick={(id) => {
                setTab('area')
                setDirAt(null)
                setCutPick((cur) => (cur === id ? null : id))
              }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 border rounded bg-white p-2 relative">
            <FigureOutlinePreview
              figure={figure}
              underlay={underlay}
              onVertexPick={cutPick == null || dirAt != null ? undefined : setDirAt}
              dirPickAt={cutPick == null ? null : dirAt}
              onDirPick={(dir) => {
                if (cutPick == null || dirAt == null) return
                const cuts = figure.cuts ?? []
                const next =
                  cutPick === 'new'
                    ? [...cuts, { id: newId(), v: dirAt, dir }]
                    : cuts.map((c) => (c.id === cutPick ? { ...c, v: dirAt, dir } : c))
                // 線 を 決めた ら その場 で 区分 し直す
                const pts = figureOutline(figure)
                const regions = splitByCuts(pts, next)
                onChange({
                  cuts: next,
                  ...(regions.length > 0 ? { terms: termsFromRegions(regions) } : {}),
                })
                setCutPick(null)
                setDirAt(null)
              }}
              className="w-full h-full"
            />
            {cutPick != null && (
              <div className="absolute top-1 left-1 px-2 py-1 rounded bg-blue-600 text-white text-[11px] shadow">
                {dirAt == null
                  ? '区切り線の起点にする折点を押してください'
                  : '伸ばす向き（上右下左）を押してください'}
              </div>
            )}
            {cutPick != null && (
              <button
                type="button"
                onClick={() => {
                  setCutPick(null)
                  setDirAt(null)
                }}
                className="absolute top-1 right-1 px-2 py-1 rounded border bg-white text-[11px] text-slate-600 shadow"
              >
                やめる
              </button>
            )}
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
  hasUnderlay,
  onChange,
}: {
  figure: FloorFigure
  /** 下敷き に する 階 が ある か。 棟 の 1 階 に は ずれ が 要らない */
  hasUnderlay: boolean
  onChange: (p: Partial<FloorFigure>) => void
}) {
  const moves = figure.moves
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)

  /**
   * 形 を 変えた ら 求積 も 引き直す。
   * 手 で 打った 求積表 (区分 を 持たない) は 触らない。 区切り線 が あれば
   * それ で、 無ければ 自動 で 分ける。
   */
  const setMoves = (next: Move[]) => {
    const patch: Partial<FloorFigure> = { moves: next }
    const terms = recomputeTerms({ ...figure, moves: next })
    if (terms) patch.terms = terms
    onChange(patch)
  }
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

      {hasUnderlay && (
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
      )}
    </div>
  )
}

/**
 * 形 から 求積表 を 作り直す。 作り直さない ほう が よい ときは null。
 *
 * 手 で 打った 行 (区分 を 持たない) が ある ときは そのまま に する。
 * せっかく 書いた 式 を 形 を 直す たび に 消す わけ に は いかない。
 */
function recomputeTerms(fig: FloorFigure): AreaTerm[] | null {
  const pts = figureOutline(fig)
  if (pts.length < 3) return null
  const handTyped = fig.terms.length > 0 && fig.terms.every((t) => !t.region)
  if (handTyped) return null
  const cuts = fig.cuts ?? []
  const regions = cuts.length > 0 ? splitByCuts(pts, cuts) : autoSlabs(pts)
  return regions.length > 0 ? termsFromRegions(regions) : null
}

/** 求積表 */
function AreaTable({
  figure,
  onChange,
  cutPick,
  onStartCutPick,
}: {
  figure: FloorFigure
  onChange: (p: Partial<FloorFigure>) => void
  /** 図 から 折点 を 拾って いる 対象 (cut の id、または 'new') */
  cutPick: string | null
  onStartCutPick: (id: string) => void
}) {
  const terms = figure.terms
  const setTerms = (next: AreaTerm[]) => onChange({ terms: next })
  const patch = (i: number, p: Partial<AreaTerm>) =>
    setTerms(terms.map((t, j) => (j === i ? { ...t, ...p } : t)))

  const pts = figureOutline(figure)
  const cuts = figure.cuts ?? []
  const hasRegions = terms.some((t) => t.region && t.region.length >= 3)

  /** 区分 を 作り直し、求積表 を 置き換える */
  const rebuild = (nextCuts: AreaCut[] | null) => {
    const regions =
      nextCuts == null ? autoSlabs(pts) : splitByCuts(pts, nextCuts)
    if (regions.length === 0) return
    onChange({
      cuts: nextCuts ?? [],
      terms: termsFromRegions(regions),
    })
  }

  return (
    <div className="flex flex-col min-h-0">
      {/* 求積 の 区分 */}
      <div className="mb-2 p-2 border rounded bg-slate-50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-600">求積の区分</span>
          <button
            type="button"
            onClick={() => rebuild(null)}
            disabled={pts.length < 3}
            className="px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-100 disabled:opacity-40"
            title="折点の高さで横に切り、台形の足し算にします"
          >
            自動区分
          </button>
          <button
            type="button"
            onClick={() => rebuild(cuts)}
            disabled={pts.length < 3}
            className="px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-100 disabled:opacity-40"
            title="下の区切り線で分けます。区切り線が無ければ全体で 1 区画になります"
          >
            手動区分
          </button>
          {hasRegions && (
            <button
              type="button"
              onClick={() =>
                setTerms(terms.map((t) => ({ ...t, label: undefined, region: undefined })))
              }
              className="ml-auto px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-100 text-slate-500"
            >
              区分を外す
            </button>
          )}
        </div>

        <div className="mt-1 flex items-center gap-1 flex-wrap">
          <span className="text-[11px] text-slate-500">区切り線</span>
          {cuts.length === 0 && (
            <span className="text-[11px] text-slate-400">
              「+ 図から追加」→ 図で折点 → その場で向き（上右下左）を押すと、当たった辺までで切ります。
            </span>
          )}
          {cuts.map((c, i) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-white text-[11px]"
            >
              <button
                type="button"
                onClick={() => onStartCutPick(c.id)}
                className={`px-1 rounded ${
                  cutPick === c.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="図で折点を選び直す"
              >
                {cutPick === c.id ? '図で選択中…' : `折点 ${c.v + 1}`}
              </button>
              <select
                className="text-[11px] bg-transparent"
                value={c.dir}
                onChange={(e) =>
                  onChange({
                    cuts: cuts.map((x, j) =>
                      j === i ? { ...x, dir: e.target.value as CutDir } : x,
                    ),
                  })
                }
              >
                {(Object.keys(CUT_DIR_LABEL) as CutDir[]).map((d) => (
                  <option key={d} value={d}>
                    {CUT_DIR_LABEL[d]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onChange({ cuts: cuts.filter((_, j) => j !== i) })}
                className="text-slate-400 hover:text-red-600"
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onStartCutPick('new')}
            disabled={pts.length < 4}
            className={`px-2 py-0.5 text-[11px] border rounded disabled:opacity-40 ${
              cutPick === 'new'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white hover:bg-slate-100'
            }`}
          >
            {cutPick === 'new' ? '図で選択中…' : '+ 図から追加'}
          </button>
        </div>
        {hasRegions && (
          <div className="mt-1 text-[11px] text-slate-500">
            区分は図面に一点鎖線で描き、イ・ロ・ハ…を丸で囲んで置きます。
          </div>
        )}
      </div>

      <div className="border rounded overflow-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-medium w-7">記号</th>
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
                <td colSpan={7} className="px-2 py-6 text-center text-xs text-slate-400">
                  上の「自動で区分」か、「行を追加」で式を並べます。
                </td>
              </tr>
            )}
            {terms.map((t, i) => (
              <tr key={t.id}>
                <td className="px-1 py-1 text-center">
                  {t.label && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-slate-500 text-[10px]">
                      {t.label}
                    </span>
                  )}
                </td>
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
              <span className="flex items-center gap-1">
                {t.label && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-slate-600 text-[9px] leading-none">
                    {t.label}
                  </span>
                )}
                {termFormula(t)}
              </span>
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

/** 地図 から 拾う もの */
type PickTarget =
  | { kind: 'buildingEdge' }
  | { kind: 'siteEdge' }
  | { kind: 'vertex'; row: number }
  | { kind: 'edge'; row: number }

function samePick(a: PickTarget | null, b: PickTarget): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'vertex' && b.kind === 'vertex') return a.row === b.row
  if (a.kind === 'edge' && b.kind === 'edge') return a.row === b.row
  return true
}

/** 「選択」 を 押す と 地図 から 拾える ように なる ボタン */
function PickButton({
  active,
  label,
  onClick,
  wide,
}: {
  active: boolean
  label: string
  onClick: () => void
  wide?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${wide ? 'w-full' : 'w-full'} px-2 py-1 text-xs border rounded text-left ${
        active
          ? 'bg-blue-600 text-white border-blue-600 animate-pulse'
          : 'bg-white hover:bg-slate-50 border-slate-300'
      }`}
    >
      {active ? '地図で押してください…' : label}
    </button>
  )
}

export function StepSite({
  plan,
  parcels,
  farmId,
  zone,
  conv,
  onToggleParcel,
  onPatch,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
  farmId: string | null
  zone: number
  conv: CoordinateConverter
  onToggleParcel: (workAreaId: string) => void
  onPatch: Patch
}) {
  const site = plan.site
  const setSite = (p: Partial<SitePlan>) => onPatch({ site: { ...site, ...p } })

  // 選んだ 地番 を 並び 順 の まま 束ねる (複数筆 に またがる 建物 が ある)
  const chosen = useMemo(
    () =>
      site.parcelIds
        .map((id) => parcels.find((p) => p.parcelId === id))
        .filter((p): p is ParcelOption => p != null),
    [site.parcelIds, parcels],
  )
  const sitePoints = useMemo(() => chosen.flatMap((c) => c.points), [chosen])
  const ring = useMemo(() => siteRing(sitePoints), [sitePoints])

  // 附属建物 は 別棟 な ので、棟 ごと に 据える
  const keys = useMemo(() => buildingKeys(plan.figures), [plan.figures])
  const [target, setTarget] = useState('main')
  const key = keys.includes(target) ? target : (keys[0] ?? 'main')
  const ground = groundOfBuilding(plan.figures, key)
  const place = placementOf(site, key)
  const setPlace = (p: Partial<typeof place>) => onPatch({ site: withPlacement(site, key, p) })

  // 毎回 新しい 配列 に なる と useMemo が 効かない ので 一度 で 束ねる
  const moves = useMemo(() => ground?.moves ?? [], [ground])
  const outline = useMemo(() => (ground ? figureOutline(ground) : []), [ground])

  const ready = ring.length >= 3 && moves.length >= 3
  const [note, setNote] = useState<string | null>(null)
  /**
   * 今 地図 から 何 を 拾う か。
   * 「選択」 を 押して から 地図 を 押す、の 一往復。 押した ら すぐ 解除 する ので
   * 地図 の 操作 と ぶつからない。
   */
  const [pick, setPick] = useState<PickTarget | null>(null)
  /** 地番 の 選択中 か。 この 間 だけ 地図 の 地番 を 押せる */
  const [pickingParcel, setPickingParcel] = useState(false)

  const startPick = (t: PickTarget) => {
    setPickingParcel(false)
    setPick((cur) => (samePick(cur, t) ? null : t))
  }

  const apply = (pl: { offsetE: number; offsetN: number; rotationDeg: number } | null, msg: string) => {
    if (!pl) {
      setNote('計算できませんでした。選んだ辺と境界線を見直してください。')
      return
    }
    setPlace({ ...pl, placed: true })
    setNote(msg)
  }

  const runThreePoint = () => {
    const start = place.placed
      ? { offsetE: place.offsetE, offsetN: place.offsetN, rotationDeg: place.rotationDeg }
      : centerOn(moves, ring, place.rotationDeg)
    const r = solveByPoints(moves, ring, constraints, start)
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

  // 1 辺平行 は 打って いる 間 ずっと 仮 の 配置 を 見せる。
  // 棟 が 変われば 辺 の 番号 も 変わる ので、範囲 の 外 は 0 に 丸める
  const rawParallel = parallelOf(site, key)
  const parallelSpec: ParallelSpec = {
    buildingEdge: 0,
    siteEdge: 0,
    offset: 0,
    along: 0,
    fromEnd: false,
    flip: false,
    ...(rawParallel ?? {}),
  }
  if (parallelSpec.buildingEdge >= moves.length) parallelSpec.buildingEdge = 0
  if (parallelSpec.siteEdge >= Math.max(sitePoints.length, 1)) parallelSpec.siteEdge = 0
  const setParallel = (p: NonNullable<SitePlan['parallel']>) =>
    onPatch({ site: withParallel(site, key, p) })

  const constraints = constraintsOf(site, key)
  const setConstraints = (cs: SitePlan['constraints']) =>
    onPatch({ site: withConstraints(site, key, cs) })
  const parallelPreview = useMemo(
    () => (ready && site.method === 'parallel' ? solveByParallel(moves, ring, parallelSpec) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, site.method, moves, ring, JSON.stringify(parallelSpec)],
  )
  const parallelGuideLines = useMemo(() => {
    if (site.method !== 'parallel' || ring.length < 3) return []
    const g = parallelGuides(ring, parallelSpec)
    if (!g) return []
    const out: { id: string; from: EN; to: EN; label: string }[] = []
    if (Math.abs(parallelSpec.along) > 0.0005) {
      out.push({ id: 'along', from: g.base, to: g.alongEnd, label: `延長 ${parallelSpec.along.toFixed(3)}` })
    }
    if (Math.abs(parallelSpec.offset) > 0.0005) {
      out.push({
        id: 'offset',
        from: g.alongEnd,
        to: g.target,
        label: `オフセット ${parallelSpec.offset.toFixed(3)}`,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.method, ring, JSON.stringify(parallelSpec)])

  const runParallel = () => {
    apply(solveByParallel(moves, ring, parallelSpec), '配置しました。')
  }

  /**
   * 図 に 出す 配置。
   * 据えて いれば その まま。 まだ なら 仮 の 位置 を 見せる ——
   * 1辺平行 は 打った 値 の 結果、それ 以外 は 敷地 の 中心 に 置いた もの。
   * 地番 を 選んだ 直後 に 建物 が どこ にも 見えない のを 避ける ため。
   */
  const shown = useMemo(() => {
    if (place.placed) {
      return { ...place, preview: false, show: true }
    }
    if (!ready) return { offsetE: 0, offsetN: 0, rotationDeg: 0, preview: true, show: false }
    const pl = parallelPreview ?? centerOn(moves, ring, place.rotationDeg)
    return { ...pl, preview: true, show: true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(place), ready, parallelPreview, moves, ring])

  // 今 据えて いる 棟 の ほか に、既 に 据えた 棟 も 薄く 描く
  const others = useMemo(
    () =>
      keys
        .filter((k) => k !== key)
        .map((k) => {
          const g = groundOfBuilding(plan.figures, k)
          const pl = placementOf(site, k)
          if (!g || !pl.placed) return null
          const pts = placeOutline(figureOutline(g), pl.offsetE, pl.offsetN, pl.rotationDeg)
          return pts.length >= 3 ? { id: k, label: buildingLabel(k), pts } : null
        })
        .filter((x): x is { id: string; label: string; pts: { e: number; n: number }[] } => x != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, key, plan.figures, JSON.stringify(site.annexPlacements), site.offsetE, site.offsetN, site.rotationDeg, site.placed],
  )

  // 地図 で 強調 する もの
  const highlightEdge =
    site.method === 'three_point'
      ? constraints.map((c) => c.edgeIndex)
      : site.method === 'parallel'
      ? [parallelSpec.siteEdge]
      : []
  const highlightVertex =
    site.method === 'three_point' ? constraints.map((c) => c.vertexIndex) : []

  /** 地図 の 境界線 を 押した */
  const pickEdge = (edgeIndex: number) => {
    if (!pick) return
    if (pick.kind === 'siteEdge') {
      setParallel({ ...parallelSpec, siteEdge: edgeIndex })
    } else if (pick.kind === 'edge') {
      setConstraints(constraints.map((c, j) => (j === pick.row ? { ...c, edgeIndex } : c)))
    }
    setPick(null)
  }

  /** 地図 の 建物 の 角 を 押した */
  const pickVertex = (vertexIndex: number) => {
    if (pick?.kind !== 'vertex') return
    setConstraints(constraints.map((c, j) => (j === pick.row ? { ...c, vertexIndex } : c)))
    setPick(null)
  }

  /** 地図 の 建物 の 辺 を 押した */
  const pickBuildingEdge = (i: number) => {
    if (pick?.kind !== 'buildingEdge') return
    setParallel({ ...parallelSpec, buildingEdge: i })
    setPick(null)
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[23rem] shrink-0 overflow-auto">
        <Field label="敷地の地番" hint="複数の土地にまたがる建物は、まとめて選びます。">
          <ParcelPicker
            plan={plan}
            parcels={parcels}
            open={pickingParcel}
            onOpenChange={setPickingParcel}
            onToggleParcel={onToggleParcel}
          />
        </Field>

        {chosen.length > 0 && sitePoints.length === 0 && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            選んだ地番にまだ構成点がありません。地番管理で構成点を登録してください。
          </div>
        )}
        {!ground && (
          <div className="my-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
            「2 階層・形状寸法」で 主である建物1階 の形状を入れてください。
          </div>
        )}
        {ready && !place.placed && (
          <div className="my-2 px-2 py-1.5 rounded bg-blue-50 border border-blue-200 text-[11px] text-blue-800">
            建物は仮の位置（破線）です。下の方法で配置すると確定します。
          </div>
        )}

        {keys.length > 1 && (
          <Field label="据える建物" hint="附属建物は別棟なので、1 棟ずつ据えます。">
            <select
              className={inputCls}
              value={key}
              onChange={(e) => {
                setTarget(e.target.value)
                setPick(null)
                setNote(null)
              }}
            >
              {keys.map((k) => (
                <option key={k} value={k}>
                  {buildingLabel(k)}
                  {placementOf(site, k).placed ? '（配置済）' : ''}
                </option>
              ))}
            </select>
          </Field>
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
              「角」「境界線」のボタンを押してから、地図の該当箇所を押します。
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
                {constraints.map((c, i) => (
                  <tr key={c.id}>
                    <td className="py-0.5 pr-1">
                      <PickButton
                        active={pick?.kind === 'vertex' && pick.row === i}
                        onClick={() => startPick({ kind: 'vertex', row: i })}
                        label={outline[c.vertexIndex] ? `角 ${c.vertexIndex + 1}` : '未選択'}
                      />
                    </td>
                    <td className="py-0.5 pr-1">
                      <PickButton
                        active={pick?.kind === 'edge' && pick.row === i}
                        onClick={() => startPick({ kind: 'edge', row: i })}
                        label={`境界線 ${c.edgeIndex + 1}`}
                      />
                    </td>
                    <td className="py-0.5">
                      <NumField
                        value={c.distance}
                        onChange={(v) =>
                          setConstraints(
                            constraints.map((x, j) => (j === i ? { ...x, distance: v } : x)),
                          )
                        }
                        className="w-16 px-1 py-1 text-xs border rounded text-right font-mono"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => {
                          setPick(null)
                          setConstraints(constraints.filter((_, j) => j !== i))
                        }}
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
                  setConstraints([
                    ...constraints,
                    { id: newId(), vertexIndex: 0, edgeIndex: 0, distance: 0 },
                  ])
                }
                className="px-2 py-0.5 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                行を追加
              </button>
              <button
                type="button"
                onClick={runThreePoint}
                disabled={!ready || constraints.length < 3}
                className="px-3 py-0.5 text-xs border rounded bg-blue-600 text-white border-blue-600 disabled:opacity-40 hover:bg-blue-700"
              >
                配置を計算
              </button>
            </div>
            {constraints.length > 0 && constraints.length < 3 && (
              <div className="mt-1 text-[11px] text-slate-400">
                3 行そろうと向きまで決まります。
              </div>
            )}
          </div>
        )}

        {site.method === 'parallel' && (
          <ParallelFields
            spec={parallelSpec}
            moves={moves}
            pick={pick}
            onStartPick={startPick}
            ready={ready}
            onChange={setParallel}
            onRun={runParallel}
          />
        )}

        {site.method === 'manual' && (
          <div className="pt-2 mt-2 border-t">
            <Field label="東方向 (Y)">
              <NumField
                value={place.offsetE}
                onChange={(v) => setPlace({ offsetE: v, placed: true })}
              />
            </Field>
            <Field label="北方向 (X)">
              <NumField
                value={place.offsetN}
                onChange={(v) => setPlace({ offsetN: v, placed: true })}
              />
            </Field>
            <Field label="建物の向き">
              <div className="flex items-center gap-1">
                <NumField
                  value={place.rotationDeg}
                  onChange={(v) => setPlace({ rotationDeg: v, placed: true })}
                />
                <span className="text-xs text-slate-500">度</span>
              </div>
            </Field>
            {ready && (
              <button
                type="button"
                onClick={() => setPlace({ ...centerOn(moves, ring, place.rotationDeg), placed: true })}
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

        {place.placed && (
          <button
            type="button"
            onClick={() => {
              setPlace({ placed: false, offsetE: 0, offsetN: 0, rotationDeg: 0 })
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

        <div className="pt-3 mt-3 border-t">
          <div className="text-xs font-semibold text-slate-500 mb-1">隣接地のヒゲ線</div>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={site.whisker?.show ?? true}
              onChange={(e) =>
                setSite({
                  whisker: { lengthMm: site.whisker?.lengthMm ?? 10, show: e.target.checked },
                })
              }
            />
            接する土地の境界線を外側へ伸ばし、地番を添える
          </label>
          {(site.whisker?.show ?? true) && (
            <div className="mt-1 flex items-center gap-1 text-xs">
              <span className="text-slate-500">伸ばす長さ</span>
              <NumField
                value={site.whisker?.lengthMm ?? 10}
                onChange={(v) =>
                  setSite({ whisker: { show: true, lengthMm: Math.max(0, v) } })
                }
                className="w-16 px-2 py-1 text-sm border rounded text-right font-mono"
              />
              <span className="text-slate-500">mm（用紙の上）</span>
              <span className="text-slate-400">
                = 現地 {(((site.whisker?.lengthMm ?? 10) * plan.site_scale) / 1000).toFixed(1)} m
              </span>
            </div>
          )}
          <div className="mt-1 text-[11px] text-slate-400">
            取り込んである地番のうち、敷地と節点を共有するものを隣接地とみなします。
          </div>
        </div>

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

      <div className="flex-1 min-w-0 border rounded overflow-hidden">
        <FloorPlanSiteMap
          farmId={farmId}
          zone={zone}
          conv={conv}
          rings={parcels
            .filter((p) => p.parcelId != null)
            .map((p) => ({ parcelId: p.parcelId!, label: p.label, points: p.points }))}
          chosenParcelIds={site.parcelIds}
          onToggleParcelId={
            // 選択中 以外 は 押しても 何も 起きない ように する
            pickingParcel
              ? (parcelId) => {
                  const opt = parcels.find((p) => p.parcelId === parcelId)
                  if (opt) onToggleParcel(opt.workAreaId)
                }
              : undefined
          }
          ring={ring}
          outline={outline}
          placed={shown.show}
          offsetE={shown.offsetE}
          offsetN={shown.offsetN}
          rotationDeg={shown.rotationDeg}
          preview={shown.preview}
          guides={parallelGuideLines}
          others={others}
          highlightEdge={highlightEdge}
          highlightVertex={highlightVertex}
          highlightBuildingEdge={
            site.method === 'parallel' ? parallelSpec.buildingEdge : null
          }
          onBuildingEdgePick={pick?.kind === 'buildingEdge' ? pickBuildingEdge : undefined}
          onEdgePick={pick?.kind === 'siteEdge' || pick?.kind === 'edge' ? pickEdge : undefined}
          onVertexPick={pick?.kind === 'vertex' ? pickVertex : undefined}
        />
      </div>
    </div>
  )
}

/** 1 辺平行 の 入力 */
function ParallelFields({
  spec,
  moves,
  pick,
  onStartPick,
  ready,
  onChange,
  onRun,
}: {
  spec: NonNullable<SitePlan['parallel']>
  moves: Move[]
  pick: PickTarget | null
  onStartPick: (t: PickTarget) => void
  ready: boolean
  onChange: (p: NonNullable<SitePlan['parallel']>) => void
  onRun: () => void
}) {
  const p = spec
  return (
    <div className="pt-2 mt-2 border-t">
      <div className="text-[11px] text-slate-500 mb-1">
        建物の 1 辺を境界線に平行にして据えます。打っている間、地図に仮の配置を破線で出します。
      </div>
      <Field label="建物の辺">
        <PickButton
          active={pick?.kind === 'buildingEdge'}
          onClick={() => onStartPick({ kind: 'buildingEdge' })}
          label={
            moves[p.buildingEdge]
              ? `辺 ${p.buildingEdge + 1}（${moveLength(moves[p.buildingEdge]).toFixed(3)} m）`
              : '未選択'
          }
          wide
        />
      </Field>
      <Field label="平行にする境界線">
        <PickButton
          active={pick?.kind === 'siteEdge'}
          onClick={() => onStartPick({ kind: 'siteEdge' })}
          label={`境界線 ${p.siteEdge + 1}`}
          wide
        />
      </Field>
      <Field label="基点" hint="延長をどちらの端から測るか。">
        <select
          className={inputCls}
          value={p.fromEnd ? 'end' : 'start'}
          onChange={(e) => onChange({ ...p, fromEnd: e.target.value === 'end' })}
        >
          <option value="start">境界線の始点から</option>
          <option value="end">境界線の終点から</option>
        </select>
      </Field>
      <Field label="オフセット" hint="境界線から内側へ何 m 離すか。">
        <NumField value={p.offset} onChange={(v) => onChange({ ...p, offset: v })} />
      </Field>
      <Field label="延長" hint="基点から境界線に沿って何 m の位置に辺の始点を置くか。">
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
        この配置で確定
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
        <ExportBar plan={plan} parcels={parcels} />
      </div>
    </div>
  )
}


/** 成果 の 書き出し */
function ExportBar({ plan, parcels }: { plan: FloorPlan; parcels: ParcelOption[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // 筆 ごと に 渡す。 図面 に 地番名 を 入れる ため
  const siteParcels = plan.site.parcelIds
    .map((id) => parcels.find((p) => p.parcelId === id))
    .filter((p): p is ParcelOption => p != null)
    .map((p) => ({ label: p.label, points: p.points }))
  // 敷地 以外 の 地番。 接して いる もの から ヒゲ線 を 作る
  const neighborParcels = parcels
    .filter((p) => p.parcelId != null && !plan.site.parcelIds.includes(p.parcelId))
    .map((p) => ({ label: p.label, points: p.points }))
  const base = safeFileName(
    plan.title || plan.house_number || plan.parcel_number || '建物図面',
  )

  const run = async (kind: 'p21' | 'tif' | 'pdf') => {
    setBusy(kind)
    setNote(null)
    try {
      const items = buildSheet(plan, siteParcels, neighborParcels)
      if (kind === 'p21') {
        saveBlob(
          new Blob([buildP21(items, base)], { type: 'application/octet-stream' }),
          `${base}.p21`,
        )
      } else {
        // 登記 の 提出 に 合わせて 400dpi
        const cv = renderToCanvas(items, 400)
        if (kind === 'tif') saveBlob(canvasToTiff(cv, 400), `${base}.tif`)
        else saveBlob(await canvasToPdf(cv), `${base}.pdf`)
      }
      setNote('書き出しました。')
    } catch (e) {
      setNote(e instanceof Error ? e.message : '書き出せませんでした。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">成果の出力</span>
        {(['p21', 'tif', 'pdf'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => void run(k)}
            disabled={busy != null}
            className="px-3 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
          >
            {busy === k ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {k.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        TIF は 400dpi の白黒 2 値（提出用）。PDF は同じ画像を 1 枚に収めたもの。
        P21 は SXF の線と文字で出すので CAD で編集できます。
      </div>
      {note && <div className="mt-1 text-[11px] text-slate-600">{note}</div>}
    </div>
  )
}

// ========================================================================
// B4 の 用紙
// ========================================================================

/** 線種 を SVG の 刻み に */
function svgDash(style: LineStyle | undefined): string | undefined {
  if (style === 'dash') return '1.2 0.8'
  if (style === 'dashdot') return '4 1 0.8 1'
  return undefined
}

/**
 * 用紙 の 下絵。 出力 と 同じ 「描く もの の 並び」 を そのまま SVG に する ので、
 * 見えて いる もの と 出る もの が ずれない。
 */
export function SheetPreview({
  plan,
  parcels,
}: {
  plan: FloorPlan
  parcels: ParcelOption[]
}) {
  // 筆 ごと に 渡す。 図面 に 地番名 を 入れる ため
  const siteParcels = useMemo(
    () =>
      plan.site.parcelIds
        .map((id) => parcels.find((p) => p.parcelId === id))
        .filter((p): p is ParcelOption => p != null)
        .map((p) => ({ label: p.label, points: p.points })),
    [plan.site.parcelIds, parcels],
  )
  // 敷地 以外 の 地番。 接して いる もの から ヒゲ線 を 作る
  const neighborParcels = useMemo(
    () =>
      parcels
        .filter((p) => p.parcelId != null && !plan.site.parcelIds.includes(p.parcelId))
        .map((p) => ({ label: p.label, points: p.points })),
    [parcels, plan.site.parcelIds],
  )
  const items = useMemo(
    () => buildSheet(plan, siteParcels, neighborParcels),
    [plan, siteParcels, neighborParcels],
  )

  return (
    <svg
      viewBox={`0 0 ${SHEET.w} ${SHEET.h}`}
      className="w-full h-auto bg-white shadow"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={0} y={0} width={SHEET.w} height={SHEET.h} fill="#fff" />
      {items.map((it, i) => {
        if (it.kind === 'line') {
          return (
            <line
              key={i}
              x1={it.x1}
              y1={it.y1}
              x2={it.x2}
              y2={it.y2}
              stroke="#0f172a"
              strokeWidth={Math.max(it.w, 0.18)}
              strokeDasharray={svgDash(it.style)}
            />
          )
        }
        if (it.kind === 'poly') {
          const d =
            it.pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ') +
            (it.closed ? ' Z' : '')
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke="#0f172a"
              strokeWidth={Math.max(it.w, 0.18)}
              strokeDasharray={svgDash(it.style)}
            />
          )
        }
        if (it.kind === 'circle') {
          return (
            <circle
              key={i}
              cx={it.cx}
              cy={it.cy}
              r={it.r}
              fill="none"
              stroke="#0f172a"
              strokeWidth={Math.max(it.w, 0.18)}
            />
          )
        }
        const anchor = it.anchor === 'middle' ? 'middle' : it.anchor === 'end' ? 'end' : 'start'
        const transform = it.rot ? `rotate(${-it.rot} ${it.x} ${it.y})` : undefined
        if (it.pitch && it.pitch > 0) {
          const chars = Array.from(it.text)
          const total = it.pitch * (chars.length - 1)
          const start =
            it.anchor === 'middle' ? it.x - total / 2 : it.anchor === 'end' ? it.x - total : it.x
          return (
            <g key={i} transform={transform}>
              {chars.map((c, k) => (
                <text
                  key={k}
                  x={start + it.pitch! * k}
                  y={it.y}
                  fontSize={it.h}
                  fontWeight={it.bold ? 'bold' : undefined}
                  fill="#0f172a"
                >
                  {c}
                </text>
              ))}
            </g>
          )
        }
        return (
          <text
            key={i}
            x={it.x}
            y={it.y}
            fontSize={it.h}
            textAnchor={anchor}
            fontWeight={it.bold ? 'bold' : undefined}
            fill="#0f172a"
            transform={transform}
          >
            {it.text}
          </text>
        )
      })}
    </svg>
  )
}
