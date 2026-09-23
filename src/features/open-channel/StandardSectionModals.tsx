import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, X, Upload, Download } from 'lucide-react'
import {
  buildCrossSectionPath,
  elementSlopePerMeter,
  normalizeStandardSections,
  type CrossSectionElement,
  type NamedStandardSection,
  type SlopeUnit,
  type StandardCrossSection,
} from '@/stores/openChannelStore'
import {
  SEGMENT_INPUT_MODES,
  factorToSlope,
  isInputField,
  slopeToFactor,
  solveSegment,
  type SegmentField,
  type SegmentInputMode,
} from './segmentMath'

/* ───────────────────────── 共通 ───────────────────────── */

/** 「現況まで」 の 区間 を プレビュー に 描く とき の 仮 の 幅 [m] */
const NOMINAL_TO_GROUND_W = 2

const newId = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const r3 = (v: number) => Math.round(v * 1000) / 1000

const num = (t: string): number | null => {
  const v = parseFloat(t)
  return t.trim() !== '' && Number.isFinite(v) ? v : null
}

/** ファイル 書き出し (リポジトリ 内 の 他 の エクスポート と 同じ 手順) */
function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 書き出し ファイル の 中身。 他 現場 で 読み込む ため の 目印 を 付ける */
const FILE_TYPE = 'nodecloud.standard-section'
const FILE_VERSION = 1

/* ───────────────────── 断面 の プレビュー ───────────────────── */

/**
 * 区間列 を 折れ線 に して 出す だけ の 図。
 * 断面図 本体 (CrossSectionView) は 編集 や パン/ズーム を 持つ ので、
 * ここ は 形 の 確認 に 絞って 自動フィット の 読み取り 専用 に する。
 */
function CrossSectionPreview({
  cross,
  className,
  viewW = 420,
  viewH = 200,
}: {
  cross: StandardCrossSection
  className?: string
  /** viewBox の 縦横。 一覧 の サムネ と 下 に 敷く 図 で 比率 が 違う */
  viewW?: number
  viewH?: number
}) {
  const pts = useMemo(() => buildCrossSectionPath(cross), [cross])
  const W = viewW
  const H = viewH
  const pad = { top: 22, right: 16, bottom: 22, left: 16 }
  if (pts.length < 2) {
    return (
      <div
        className={
          'flex items-center justify-center text-[11px] text-slate-400 border rounded bg-slate-50 ' +
          (className ?? '')
        }
      >
        区間 を 足すと ここ に 形 が 出ます
      </div>
    )
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs, 0)
  const maxX = Math.max(...xs, 0)
  const minY = Math.min(...ys, 0)
  const maxY = Math.max(...ys, 0)
  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const scale = Math.min(innerW / spanX, innerH / spanY)
  const offX = pad.left + (innerW - spanX * scale) / 2 - minX * scale
  const offY = pad.top + (innerH - spanY * scale) / 2 + maxY * scale
  const tx = (x: number) => offX + x * scale
  const ty = (y: number) => offY - y * scale
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`).join(' ')
  return (
    <div className={'border rounded bg-slate-50 ' + (className ?? '')}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <line
          x1={tx(0)}
          y1={pad.top}
          x2={tx(0)}
          y2={H - pad.bottom}
          stroke="#cbd5e1"
          strokeDasharray="3,3"
        />
        <text x={tx(0)} y={16} fontSize={11} fontWeight={700} fill="#94a3b8" textAnchor="middle">
          CL
        </text>
        <text x={pad.left} y={16} fontSize={13} fontWeight={700} fill="#64748b">
          L
        </text>
        <text
          x={W - pad.right}
          y={16}
          fontSize={13}
          fontWeight={700}
          fill="#64748b"
          textAnchor="end"
        >
          R
        </text>
        <path d={d} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={tx(p.x)}
            cy={ty(p.y)}
            r={3}
            fill={Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9 ? '#0ea5e9' : '#fff'}
            stroke="#0ea5e9"
            strokeWidth={1.5}
          />
        ))}
      </svg>
    </div>
  )
}

/* ─────────────────── 区間 1 行 の 下書き ─────────────────── */

type RowDraft = {
  key: string
  name: string
  widthText: string
  slopeText: string
  heightText: string
  lengthText: string
  /** 「現況まで」 の とき、 交点 から さらに 伸ばす 幅 [m] */
  marginText: string
  unit: 'percent' | 'ratio'
  /** どの 2 つ を 手入力 に する か。 残り は 自動計算 */
  mode: SegmentInputMode
}

/** 入力 中 の 行 を 解く */
function solveDraft(d: RowDraft) {
  const sv = isInputField(d.mode, 'slope') ? num(d.slopeText) : null
  return solveSegment(d.mode, {
    width: isInputField(d.mode, 'width') ? num(d.widthText) : null,
    height: isInputField(d.mode, 'height') ? num(d.heightText) : null,
    slopeFactor: sv == null ? null : slopeToFactor(sv, d.unit),
    length: isInputField(d.mode, 'length') ? num(d.lengthText) : null,
    marginW: num(d.marginText) ?? 0,
  })
  // 標準断面 で は 現況 が 無い ので 'toGround' は 必ず ok:false に なる。
  // 長さ は 測点 へ 取り込む とき に 決まる。
}

/** 保存 済み の 区間 → 編集 用 の 下書き */
function toDraft(e: CrossSectionElement): RowDraft {
  if (e.slopeUnit === 'vertical') {
    // 直高 区間 は 幅 0。 勾配 が 決まら ない ので 幅 + 直高 で 持つ
    return {
      key: e.id || newId('row'),
      name: e.name ?? '',
      widthText: '0',
      slopeText: '',
      heightText: String(r3(e.slopeValue)),
      lengthText: String(r3(Math.abs(e.slopeValue))),
      marginText: '',
      unit: 'percent',
      mode: 'widthHeight',
    }
  }
  if (e.toGround) {
    // 長さ は 取込 時 に 決まる ので 勾配 と 余裕幅 だけ 持つ
    return {
      key: e.id || newId('row'),
      name: e.name ?? '',
      widthText: '',
      slopeText: String(r3(e.slopeValue)),
      heightText: '',
      lengthText: '',
      marginText: e.toGround.marginW ? String(r3(e.toGround.marginW)) : '',
      unit: e.slopeUnit === 'ratio' ? 'ratio' : 'percent',
      mode: 'toGround',
    }
  }
  const f = elementSlopePerMeter(e)
  const h = e.width * f
  return {
    key: e.id || newId('row'),
    name: e.name ?? '',
    widthText: String(r3(e.width)),
    slopeText: String(r3(e.slopeValue)),
    heightText: String(r3(h)),
    lengthText: String(r3(Math.hypot(e.width, h))),
    marginText: '',
    unit: e.slopeUnit === 'ratio' ? 'ratio' : 'percent',
    mode: 'widthSlope',
  }
}

/**
 * 下書き → 保存 形式。
 * 幅 0 は 直高 区間。 勾配 を 手 で 入れて いる ときは その 単位 (% / 1:n) を
 * 残す。 法長 など から 求めた ときは % に 直す。
 * 幅 は 大きさ だけ を 持つ モデル な ので 絶対値 に する。
 */
function toElement(d: RowDraft): CrossSectionElement | null {
  if (d.mode === 'toGround') {
    // 長さ は 取込 時 に 現況 と の 交点 で 決まる。 ここ で は 勾配 だけ 保存 する。
    // width は 0 に して おく (この 印 を 知ら ない 処理 が 素通り できる ように)
    const sv = num(d.slopeText)
    if (sv == null || slopeToFactor(sv, d.unit) == null) return null
    return {
      id: d.key,
      name: d.name,
      width: 0,
      slopeValue: sv,
      slopeUnit: d.unit,
      toGround: { marginW: num(d.marginText) ?? 0 },
    }
  }
  const r = solveDraft(d)
  if (!r.ok) return null
  const { w, h } = r.value
  const width = Math.abs(w)
  if (width < 1e-9) {
    return { id: d.key, name: d.name, width: 0, slopeValue: r3(h), slopeUnit: 'vertical' }
  }
  if (isInputField(d.mode, 'slope')) {
    const sv = num(d.slopeText)
    if (sv != null) {
      const unit: SlopeUnit = d.unit
      return { id: d.key, name: d.name, width: r3(width), slopeValue: sv, slopeUnit: unit }
    }
  }
  return {
    id: d.key,
    name: d.name,
    width: r3(width),
    slopeValue: r3((h / width) * 100),
    slopeUnit: 'percent',
  }
}

const emptyDraft = (): RowDraft => ({
  key: newId('row'),
  name: '',
  widthText: '',
  slopeText: '',
  heightText: '',
  lengthText: '',
  marginText: '',
  unit: 'percent',
  mode: 'widthSlope',
})

/* ─────────────────── 作成 / 編集 モーダル ─────────────────── */

/**
 * 標準断面 を 1 つ 作る / 直す ダイアログ。
 *
 * 区間 は 中心 から 外 向き に 並べる。 各行 は 幅 / 勾配 / 直高 の 3 入力 で、
 * 「自」 を 押した 欄 が 自動計算 に なる (計画点計算 と 同じ 操作感)。
 * 保存 形式 は 幅 + 勾配 + 単位 な ので、 直高 だけ の 区間 は 幅 0 に なる。
 */
export function StandardSectionEditModal({
  initial,
  onSave,
  onClose,
}: {
  /** 編集 する 断面。 null なら 新規 */
  initial: NamedStandardSection | null
  onSave: (section: NamedStandardSection) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [left, setLeft] = useState<RowDraft[]>(() =>
    (initial?.cross.left ?? []).map(toDraft),
  )
  const [right, setRight] = useState<RowDraft[]>(() =>
    (initial?.cross.right ?? []).map(toDraft),
  )

  const cross: StandardCrossSection = useMemo(() => {
    const conv = (rows: RowDraft[]) =>
      rows.map(toElement).filter((e): e is CrossSectionElement => e != null)
    return { left: conv(left), right: conv(right) }
  }, [left, right])

  /**
   * プレビュー 用。 「現況まで」 は ここ で は 長さ が 決まら ない ので、
   * 形 が 見える ように 仮 の 幅 で 描く。 実際 の 長さ は 測点 ごと に 変わる。
   */
  const previewCross: StandardCrossSection = useMemo(() => {
    const fix = (es: CrossSectionElement[]) =>
      es.map((e) =>
        e.toGround ? { ...e, width: NOMINAL_TO_GROUND_W, toGround: undefined } : e,
      )
    return { left: fix(cross.left), right: fix(cross.right) }
  }, [cross])
  const hasToGround = [...cross.left, ...cross.right].some((e) => e.toGround)

  const leftBad = left.filter((d) => toElement(d) == null).length
  const rightBad = right.filter((d) => toElement(d) == null).length
  const canSave = name.trim() !== '' && cross.left.length + cross.right.length > 0

  const setRows = (side: 'left' | 'right') => (side === 'left' ? setLeft : setRight)
  const rowsOf = (side: 'left' | 'right') => (side === 'left' ? left : right)

  const patchRow = (side: 'left' | 'right', key: string, patch: Partial<RowDraft>) =>
    setRows(side)((rows) => rows.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const addRow = (side: 'left' | 'right') => setRows(side)((rows) => [...rows, emptyDraft()])
  const removeRow = (side: 'left' | 'right', key: string) =>
    setRows(side)((rows) => rows.filter((d) => d.key !== key))
  const moveRow = (side: 'left' | 'right', key: string, dir: -1 | 1) =>
    setRows(side)((rows) => {
      const i = rows.findIndex((d) => d.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= rows.length) return rows
      const next = [...rows]
      const t = next[i]
      next[i] = next[j]
      next[j] = t
      return next
    })
  /** 反対側 へ そのまま 写す (一度きり。 以後 は 別々 に 直せる) */
  const copySide = (from: 'left' | 'right') => {
    const src = rowsOf(from).map((d) => ({ ...d, key: newId('row') }))
    setRows(from === 'left' ? 'right' : 'left')(src)
  }

  /** 入力方法 を 変える。 いま 出て いる 値 を 全部 の 欄 に 固定 して から 移す */
  const pickMode = (side: 'left' | 'right', d: RowDraft, mode: SegmentInputMode) => {
    if (mode === d.mode) return
    const r = solveDraft(d)
    const patch: Partial<RowDraft> = { mode }
    if (r.ok) {
      patch.widthText = String(r3(r.value.w))
      patch.heightText = String(r3(r.value.h))
      patch.lengthText = String(r3(r.value.l))
      if (r.value.f != null) patch.slopeText = factorToSlope(r.value.f, d.unit)
    }
    patchRow(side, d.key, patch)
  }

  const textOf = (d: RowDraft, k: SegmentField): string =>
    k === 'slope'
      ? d.slopeText
      : k === 'width'
        ? d.widthText
        : k === 'height'
          ? d.heightText
          : d.lengthText
  const patchOf = (k: SegmentField, value: string): Partial<RowDraft> =>
    k === 'slope'
      ? { slopeText: value }
      : k === 'width'
        ? { widthText: value }
        : k === 'height'
          ? { heightText: value }
          : { lengthText: value }

  /** 手入力 の 欄 は 打った 文字 を、 自動計算 の 欄 は 計算 値 を 出す */
  const shown = (d: RowDraft, k: SegmentField): string => {
    if (isInputField(d.mode, k)) return textOf(d, k)
    // 「現況まで」 は 測点 ごと に 変わる ので ここ で は 数字 を 出さない
    if (d.mode === 'toGround') return '現況まで'
    const r = solveDraft(d)
    if (!r.ok) return ''
    const v = r.value
    if (k === 'width') return v.w.toFixed(3)
    if (k === 'height') return v.h.toFixed(3)
    if (k === 'length') return v.l.toFixed(3)
    return v.f == null ? '直立' : factorToSlope(v.f, d.unit)
  }

  const inputCls = (isAuto: boolean) =>
    'w-full px-1 py-0.5 border rounded text-right tabular-nums text-xs ' +
    (isAuto ? 'bg-slate-100 text-slate-500' : 'bg-white')

  const renderSide = (side: 'left' | 'right') => {
    const rows = rowsOf(side)
    const bad = side === 'left' ? leftBad : rightBad
    return (
      <div className="border rounded overflow-hidden">
        <div className="px-2 py-1 bg-slate-100 text-[11px] font-semibold text-slate-600 flex items-center gap-1">
          {side === 'left' ? '左 (L)' : '右 (R)'}
          <span className="text-slate-400 font-normal">{rows.length} 区間</span>
          {bad > 0 && <span className="ml-auto text-amber-600">入力待ち {bad}</span>}
        </div>
        <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[40rem]">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-1 py-1 text-left">名前</th>
              <th className="px-1 py-1 text-left w-28">入力方法</th>
              <th className="px-1 py-1 text-right w-20">幅 (m)</th>
              <th className="px-1 py-1 text-right w-24">勾配</th>
              <th className="px-1 py-1 text-right w-20">直高 (m)</th>
              <th className="px-1 py-1 text-right w-20">法長 (m)</th>
              <th
                className="px-1 py-1 text-right w-20"
                title="「現況まで」 の とき、 交点 から さらに 伸ばす 幅"
              >
                余裕幅 (m)
              </th>
              <th className="px-1 py-1 w-16" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.key} className="border-t align-top">
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={d.name}
                    onChange={(e) => patchRow(side, d.key, { name: e.target.value })}
                    placeholder="床 / 法面 など"
                    className="w-full px-1 py-0.5 border rounded text-xs"
                  />
                </td>
                <td className="px-1 py-1">
                  <select
                    value={d.mode}
                    onChange={(e) =>
                      pickMode(side, d, e.target.value as SegmentInputMode)
                    }
                    className="w-full px-1 py-0.5 border rounded text-xs bg-white"
                    title="この 2 つ を 入力 し、 残り を 計算 します"
                  >
                    {SEGMENT_INPUT_MODES.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </td>
                {(['width', 'slope', 'height', 'length'] as const).map((k) => (
                  <td key={k} className="px-1 py-1">
                    <div className="flex items-center gap-0.5">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={shown(d, k)}
                        readOnly={!isInputField(d.mode, k)}
                        onChange={(e) => patchRow(side, d.key, patchOf(k, e.target.value))}
                        className={inputCls(!isInputField(d.mode, k))}
                      />
                      {k === 'slope' && (
                        <button
                          onClick={() =>
                            patchRow(side, d.key, {
                              unit: d.unit === 'percent' ? 'ratio' : 'percent',
                            })
                          }
                          className="shrink-0 px-1 py-0.5 text-[10px] border rounded bg-white hover:bg-slate-50 text-slate-600"
                          title="% と 1:n を 切り替える"
                        >
                          {d.unit === 'percent' ? '%' : '1:n'}
                        </button>
                      )}
                    </div>
                  </td>
                ))}
                <td className="px-1 py-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={d.mode === 'toGround' ? d.marginText : ''}
                    readOnly={d.mode !== 'toGround'}
                    onChange={(e) => patchRow(side, d.key, { marginText: e.target.value })}
                    placeholder={d.mode === 'toGround' ? '0' : '-'}
                    className={inputCls(d.mode !== 'toGround')}
                  />
                </td>
                <td className="px-1 py-1 whitespace-nowrap text-center">
                  <button
                    onClick={() => moveRow(side, d.key, -1)}
                    disabled={rows[0]?.key === d.key}
                    className="p-0.5 border rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                    title="1 つ 中心 側 へ"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => moveRow(side, d.key, 1)}
                    disabled={rows[rows.length - 1]?.key === d.key}
                    className="ml-0.5 p-0.5 border rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                    title="1 つ 外 側 へ"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => removeRow(side, d.key)}
                    className="ml-0.5 p-0.5 border rounded hover:bg-red-50 text-red-600"
                    title="この 区間 を 消す"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
            <tr className="border-t bg-slate-50/60">
              <td colSpan={8} className="px-1 py-1">
                <button
                  onClick={() => addRow(side)}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100 text-slate-600"
                >
                  <Plus className="h-3 w-3" />区間 を 足す
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[3200] flex items-center justify-center p-4">
      <div className="bg-white rounded shadow-xl w-[84rem] max-w-full max-h-[90vh] flex flex-col">
        <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
          <span className="text-sm font-semibold text-slate-700">
            {initial ? '標準断面 の 編集' : '標準断面 の 新規作成'}
          </span>
          <button onClick={onClose} className="p-0.5 hover:bg-slate-100 rounded">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="p-3 space-y-2 overflow-auto">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-10 shrink-0 text-slate-600">名前</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="台形水路 B=1.0 H=1.2"
              className="flex-1 px-2 py-1 border rounded"
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-10 shrink-0 text-slate-600">補足</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1 border rounded"
            />
          </div>

          {/* 上 に 左右 の 区間表 を 並べ、 下 に 断面図 を 敷く。
              横断図 の 画面 (表 → その 下 に 図) と 同じ 並び に 揃える。 */}
          <div className="grid grid-cols-2 gap-3 items-start">
            {renderSide('left')}
            {renderSide('right')}
          </div>

          <div className="flex items-center gap-1 text-[11px] flex-wrap">
            <button
              onClick={() => copySide('left')}
              className="px-2 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-600"
              title="左 の 区間 を 右 に 写す"
            >
              左 → 右 に コピー
            </button>
            <button
              onClick={() => copySide('right')}
              className="px-2 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-600"
              title="右 の 区間 を 左 に 写す"
            >
              右 → 左 に コピー
            </button>
            <span className="text-slate-400">
              中心 に 近い 順。 「自」 の 欄 が 計算 で 埋まります
            </span>
            <span className="ml-auto text-slate-500">
              左 {cross.left.length} 区間 / 右 {cross.right.length} 区間
              {leftBad + rightBad > 0 && (
                <span className="text-amber-600"> — 入力 が 足り ない 区間 は 図 に 出ません</span>
              )}
            </span>
          </div>

          <CrossSectionPreview cross={previewCross} viewW={900} viewH={260} className="h-64" />
          {hasToGround && (
            <div className="text-[11px] text-amber-600">
              「勾配 ～ 現況まで」 の 区間 は 仮 の 幅 {NOMINAL_TO_GROUND_W.toFixed(1)}m で
              描いて います。 実際 の 長さ は 測点 ごと に 現況断面 と の 交点 で 決まります。
              勾配 は 大きさ だけ 決めて おけば よく、 上り か 下り か は 測点 ごと に
              現況 が 上 に ある か 下 に ある か で 自動 で 決まります
              (切土 の 測点 でも 盛土 の 測点 でも 同じ 定義 が 使えます)。
            </div>
          )}
        </div>

        <div className="px-3 py-2 border-t flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
          >
            キャンセル
          </button>
          <button
            onClick={() => {
              if (!canSave) return
              onSave({
                id: initial?.id ?? newId('ss'),
                name: name.trim(),
                note: note.trim() || undefined,
                cross,
              })
            }}
            disabled={!canSave}
            className="px-3 py-1 text-xs border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700 disabled:opacity-40"
            title={canSave ? undefined : '名前 と 区間 を 1 つ 以上 入れて ください'}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────── 選択 パネル ─────────────────── */

/**
 * 標準断面 の 一覧。 測点 へ 取り込む 断面 を ここ で 選ぶ。
 * 新規作成 / 編集 / 複製 / 削除 と、 他 現場 へ 持ち出す ため の
 * ファイル 書き出し・読み込み も ここ に まとめる。
 */
export function StandardSectionPickerModal({
  sections,
  legacyCross,
  onChangeSections,
  onImport,
  onClose,
}: {
  sections: NamedStandardSection[]
  /**
   * 旧 の 単一 標準断面。 ライブラリ に 移して いない 路線 でも
   * そのまま 取り込める ように 候補 の 末尾 に 出す。
   */
  legacyCross: StandardCrossSection | null
  onChangeSections: (next: NamedStandardSection[]) => void
  /** その 断面 を いま の 測点 の 計画断面 に する */
  onImport: (cross: StandardCrossSection) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<{ section: NamedStandardSection | null } | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const legacyCount = legacyCross
    ? legacyCross.left.length + legacyCross.right.length
    : 0

  const handleSave = (s: NamedStandardSection) => {
    const exists = sections.some((x) => x.id === s.id)
    onChangeSections(exists ? sections.map((x) => (x.id === s.id ? s : x)) : [...sections, s])
    setEditing(null)
  }
  const handleDuplicate = (s: NamedStandardSection) => {
    onChangeSections([
      ...sections,
      { ...s, id: newId('ss'), name: `${s.name} の コピー` },
    ])
  }
  const handleDelete = (s: NamedStandardSection) => {
    if (!window.confirm(`標準断面 「${s.name}」 を 消します。よろしいですか？`)) return
    onChangeSections(sections.filter((x) => x.id !== s.id))
  }

  const handleExport = () => {
    if (sections.length === 0) return
    downloadJson(`standard-sections-${new Date().toISOString().slice(0, 10)}.json`, {
      type: FILE_TYPE,
      version: FILE_VERSION,
      sections: sections.map((s) => ({ name: s.name, note: s.note, cross: s.cross })),
    })
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    setError('')
    try {
      const raw = JSON.parse(await file.text()) as {
        type?: string
        version?: number
        sections?: unknown
      }
      if (raw.type !== FILE_TYPE) {
        setError('この ファイル は 標準断面 の 書き出し では ありません')
        return
      }
      if (typeof raw.version !== 'number' || raw.version > FILE_VERSION) {
        setError('新しい 形式 の ファイル です。 アプリ を 更新 して ください')
        return
      }
      // id は 振り直す (他 現場 の id と ぶつからない ように)
      const incoming = normalizeStandardSections(
        (Array.isArray(raw.sections) ? raw.sections : []).map((s) => ({
          ...(s as object),
          id: newId('ss'),
        })),
      )
      if (incoming.length === 0) {
        setError('読み込める 断面 が ありません でした')
        return
      }
      // 同名 は 上書き せず 連番 を 付けて 足す
      const used = new Set(sections.map((s) => s.name))
      const renamed = incoming.map((s) => {
        let name = s.name
        let n = 2
        while (used.has(name)) name = `${s.name} (${n++})`
        used.add(name)
        return { ...s, name }
      })
      onChangeSections([...sections, ...renamed])
    } catch {
      setError('ファイル を 読めません でした (JSON では ない 可能性)')
    }
  }

  const row = (
    key: string,
    name: string,
    count: number,
    cross: StandardCrossSection,
    actions: React.ReactNode,
    note?: string,
  ) => (
    <div key={key} className="border rounded p-2 flex items-center gap-3">
      <CrossSectionPreview cross={cross} className="w-40 h-20 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-slate-700 truncate">{name}</div>
        <div className="text-[11px] text-slate-500">
          左 {cross.left.length} / 右 {cross.right.length} 区間（計 {count}）
        </div>
        {note && <div className="text-[11px] text-slate-400 truncate">{note}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">{actions}</div>
    </div>
  )

  const btn = 'px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 text-slate-600'

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-[3100] flex items-center justify-center p-4">
        <div className="bg-white rounded shadow-xl w-[44rem] max-w-full max-h-[85vh] flex flex-col">
          <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
            <span className="text-sm font-semibold text-slate-700">標準断面</span>
            <button onClick={onClose} className="p-0.5 hover:bg-slate-100 rounded">
              <X className="h-4 w-4 text-slate-500" />
            </button>
          </div>

          <div className="px-3 py-2 border-b flex items-center gap-1 shrink-0">
            <button
              onClick={() => setEditing({ section: null })}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
            >
              <Plus className="h-3 w-3" />新規作成
            </button>
            <span className="ml-auto flex items-center gap-1">
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  void handleFile(e.target.files?.[0] ?? null)
                  e.target.value = ''
                }}
              />
              <button onClick={() => fileRef.current?.click()} className={btn} title="他 現場 で 書き出した ファイル を 読み込む">
                <Upload className="inline h-3 w-3 mr-0.5" />
                ファイル読込
              </button>
              <button
                onClick={handleExport}
                disabled={sections.length === 0}
                className={btn + ' disabled:opacity-40'}
                title="この 路線 の 標準断面 を まとめて 書き出す"
              >
                <Download className="inline h-3 w-3 mr-0.5" />
                書出
              </button>
            </span>
          </div>

          {error && <div className="px-3 py-1 text-[11px] text-red-600 shrink-0">{error}</div>}

          <div className="p-3 space-y-2 overflow-auto">
            {sections.length === 0 && legacyCount === 0 && (
              <div className="px-2 py-6 text-center text-xs text-slate-400 border rounded">
                まだ 標準断面 が ありません。「新規作成」 か 「ファイル読込」 から 始めて ください。
              </div>
            )}

            {sections.map((s) =>
              row(
                s.id,
                s.name,
                s.cross.left.length + s.cross.right.length,
                s.cross,
                <>
                  <button
                    onClick={() => onImport(s.cross)}
                    className="px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
                    title="この 断面 を いま の 測点 の 計画断面 に する"
                  >
                    取込
                  </button>
                  <button onClick={() => setEditing({ section: s })} className={btn}>
                    編集
                  </button>
                  <button onClick={() => handleDuplicate(s)} className={btn}>
                    複製
                  </button>
                  <button
                    onClick={() => handleDelete(s)}
                    className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-red-50 text-red-600"
                  >
                    削除
                  </button>
                </>,
                s.note,
              ),
            )}

            {/* ライブラリ に 移して いない 路線 の 救済。 編集 すると 名前 付き で 残る */}
            {legacyCross && legacyCount > 0 &&
              row(
                'legacy',
                '(現在の標準断面)',
                legacyCount,
                legacyCross,
                <>
                  <button
                    onClick={() => onImport(legacyCross)}
                    className="px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
                  >
                    取込
                  </button>
                  <button
                    onClick={() =>
                      setEditing({
                        section: {
                          id: newId('ss'),
                          name: '標準断面',
                          cross: legacyCross,
                        },
                      })
                    }
                    className={btn}
                    title="名前 を 付けて ライブラリ に 取り込む"
                  >
                    名前を付けて追加
                  </button>
                </>,
                'この 路線 に 元々 入って いる 断面です',
              )}
          </div>

          <div className="px-3 py-2 border-t flex justify-end shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>

      {editing && (
        <StandardSectionEditModal
          initial={editing.section}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}