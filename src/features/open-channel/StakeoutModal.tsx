import { useEffect, useState } from 'react'
import { Plus, Trash2, X, Loader2 } from 'lucide-react'
import type {
  ChohariPoint,
  MeasuredCrossPoint,
  TomboPoint,
} from '@/stores/openChannelStore'
import { labelOfPoint } from './sectionPointLabel'

/** 解決 済み の トンボ。 断面 上 の 位置 と 実座標 */
export interface ResolvedTombo {
  /** 基準 に した 変化点 (見つから なければ null) */
  base: MeasuredCrossPoint | null
  /** 中心 から の 離れ [m] (右 +, 左 -) */
  offset: number
  /** 計画 トンボ高 [m] */
  elevation: number
  /** 実座標。 線形 が 引けて いない と null */
  world: { x: number; y: number } | null
}

/** 解決 済み の 丁張 */
export interface ResolvedChohari {
  /** 杭 の 基準 に した 計画点 (法尻 など) */
  base: MeasuredCrossPoint | null
  /** 対象 法面 の もう 一方 の 端 (法肩 など) */
  crest: MeasuredCrossPoint | null
  /** 杭 の 離れ [m] (右 +, 左 -) */
  offset: number
  /** 杭 の 位置 で 法面線 を 延ばした 高さ = 丁張高 [m] */
  elevation: number
  /** 杭 の 位置 から 法肩 まで の 斜長 [m] */
  slopeLength: number
  /** 外 へ 1m あたり の 上がり。 垂直 な 法面 は null */
  factor: number | null
  world: { x: number; y: number } | null
  /** 解け なかった 理由 */
  error?: string
}

/** 断面図 の クリック 待ち。 どの 行 の どの 欄 を 決めよう と して いるか */
export type PickTarget = {
  /**
   * tombo      : トンボ の 基準 に する 計画点
   * choSegment : 丁張 の 対象 法面 (計画線 の 線分)
   * choBase    : その 線分 の どちら の 端 から W を 測る か
   * choPos     : 杭 の 位置 を 図 で 決める (W に 換算 する)
   */
  kind: 'tombo' | 'choSegment' | 'choBase' | 'choPos'
  rowId: string
}

const newId = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const num = (t: string): number | null => {
  const v = parseFloat(t)
  return t.trim() !== '' && Number.isFinite(v) ? v : null
}

/** 法勾配 を 1:n で。 垂直 は 「直立」 */
function ratioText(f: number | null): string {
  if (f == null) return '直立'
  if (Math.abs(f) < 1e-9) return '水平'
  const n = 1 / Math.abs(f)
  return `1:${n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')}${f > 0 ? '↑' : '↓'}`
}

/**
 * トンボ / 丁張 の 計算。
 *
 * どちら も 計画横断 の 変化点 を 断面図 で クリック して 決める ので、
 * 背景 は 暗く せず 図 を 触れる ように して おく (覆い は クリック を 通す)。
 */
export function StakeoutModal({
  stationLabel,
  prevStation,
  nextStation,
  onSwitchStation,
  planPoints,
  tombos,
  chohari,
  resolveTombo,
  resolveChohari,
  onChangeTombos,
  onChangeChohari,
  onRegisterTombos,
  onRegisterChohari,
  picking,
  onPick,
  onClose,
}: {
  stationLabel: string
  planPoints: MeasuredCrossPoint[]
  tombos: TomboPoint[]
  chohari: ChohariPoint[]
  resolveTombo: (t: TomboPoint) => ResolvedTombo | null
  resolveChohari: (c: ChohariPoint) => ResolvedChohari | null
  onChangeTombos: (next: TomboPoint[]) => void
  onChangeChohari: (next: ChohariPoint[]) => void
  onRegisterTombos: (items: { tombo: TomboPoint; resolved: ResolvedTombo }[]) => Promise<void>
  onRegisterChohari: (
    items: { cho: ChohariPoint; resolved: ResolvedChohari }[],
  ) => Promise<void>
  /** 前 / 次 の 測点 (端 なら null)。 続けて 計算 できる ように する */
  prevStation: { id: string; label: string } | null
  nextStation: { id: string; label: string } | null
  onSwitchStation: (stationId: string) => void
  picking: PickTarget | null
  onPick: (t: PickTarget | null) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'tombo' | 'chohari'>('tombo')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /**
   * 数値 欄 の 入力 中 の 文字。 数値 を そのまま value に 戻す と 「0.」 の
   * 途中 で 丸められ 小数 が 打て ない。 打って いる 間 は この 文字 を 出す。
   */
  const [draft, setDraft] = useState<Record<string, string>>({})

  /** 断面図 を 触れる ように 覆い は 透過。 位置 も 動かせる */
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  )
  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) =>
      setPos({ x: drag.ox + (e.clientX - drag.sx), y: drag.oy + (e.clientY - drag.sy) })
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag])

  const cell = 'px-1.5 py-1 border rounded text-right tabular-nums text-sm bg-white w-full'

  /** 数値 欄。 文字 は 手元 に 残し、 数値 に できた ときだけ 反映 する */
  const numInput = (key: string, value: number, apply: (v: number) => void) => (
    <input
      type="text"
      inputMode="decimal"
      value={draft[key] ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value
        setDraft((d) => ({ ...d, [key]: raw }))
        const v = num(raw)
        if (v != null) apply(v)
      }}
      onBlur={() =>
        setDraft((d) => {
          const next = { ...d }
          delete next[key]
          return next
        })
      }
      className={cell}
    />
  )

  /** 断面図 で 点 を 選ぶ ボタン */
  const pickButton = (t: PickTarget, label: string) => {
    const on = picking?.kind === t.kind && picking.rowId === t.rowId
    return (
      <button
        onClick={() => onPick(on ? null : t)}
        className={
          'shrink-0 px-2 py-0.5 text-[11px] border rounded ' +
          (on
            ? 'bg-pink-600 text-white border-pink-600'
            : 'bg-white hover:bg-slate-50 text-slate-600')
        }
        title="断面図 の 計画点 を クリック して 決める"
      >
        {on ? '図で選択中…' : label}
      </button>
    )
  }

  /* ─── トンボ ─── */
  const addTombo = () => {
    const base = [...planPoints].sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset))[0]
    if (!base) {
      setMsg('計画断面 の 変化点 が ありません。 先 に 計画 を 作って ください。')
      return
    }
    setMsg('')
    const id = newId('tb')
    onChangeTombos([
      ...tombos,
      // W は 既定 0 (基準 の 計画点 の 真上 に 立てる のが 普通)
      { id, basePointId: base.id, baseOffset: base.offset, dw: 0, dh: 1.0 },
    ])
    onPick({ kind: 'tombo', rowId: id })
  }

  const tomboRows = tombos.map((t) => ({ t, r: resolveTombo(t) }))
  const tomboNotYet = tomboRows.filter((x) => x.r?.world && !x.t.coordinateId)

  const registerTombos = async (only?: string) => {
    const items = tomboRows
      .filter((x) => x.r?.world && (only ? x.t.id === only : !x.t.coordinateId))
      .map((x) => ({ tombo: x.t, resolved: x.r as ResolvedTombo }))
    if (items.length === 0) return
    setBusy(true)
    setMsg('')
    try {
      await onRegisterTombos(items)
      setMsg(`トンボ ${items.length} 点 を 座標管理 に 登録 しました。`)
    } finally {
      setBusy(false)
    }
  }

  /* ─── 丁張 ─── */
  const addChohari = () => {
    // 既定 は 一番 外側 の 点 を 法尻、 その 1 つ 内側 を 法肩 と する
    const sorted = [...planPoints].sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset))
    const base = sorted[0]
    if (!base) {
      setMsg('計画断面 の 変化点 が ありません。 先 に 計画 を 作って ください。')
      return
    }
    const sameSide = sorted.filter(
      (p) => (p.offset >= 0) === (base.offset >= 0) && p.id !== base.id,
    )
    const crest = sameSide[0] ?? base
    setMsg('')
    const id = newId('ch')
    onChangeChohari([
      ...chohari,
      {
        id,
        basePointId: base.id,
        baseOffset: base.offset,
        crestPointId: crest.id,
        crestOffset: crest.offset,
        w: 0.5,
      },
    ])
    onPick({ kind: 'choSegment', rowId: id })
  }

  const choRows = chohari.map((c) => ({ c, r: resolveChohari(c) }))
  const choNotYet = choRows.filter((x) => x.r?.world && !x.r.error && !x.c.coordinateId)

  const registerChohari = async (only?: string) => {
    const items = choRows
      .filter((x) => x.r?.world && !x.r.error && (only ? x.c.id === only : !x.c.coordinateId))
      .map((x) => ({ cho: x.c, resolved: x.r as ResolvedChohari }))
    if (items.length === 0) return
    setBusy(true)
    setMsg('')
    try {
      await onRegisterChohari(items)
      setMsg(`丁張 ${items.length} 点 を 座標管理 に 登録 しました。`)
    } finally {
      setBusy(false)
    }
  }

  const tabCls = (on: boolean) =>
    'px-3 py-1 text-sm border rounded ' +
    (on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50 text-slate-700')

  /** トンボ の 基準点 の 見出し */
  const baseLabel = (p: MeasuredCrossPoint | null, fallbackOffset: number) =>
    p ? `${labelOfPoint(p)} / ${p.elevation.toFixed(3)}` : `(点 が ありません: 離れ ${fallbackOffset.toFixed(3)})`

  return (
    // 断面図 を 見ながら 点 を 選びたい ので 背景 は 暗く しない。
    <div className="fixed inset-0 z-[3100] flex items-center justify-center p-4 pointer-events-none">
      <div
        className="bg-white rounded shadow-xl border w-[70rem] max-w-full max-h-[88vh] flex flex-col pointer-events-auto"
        style={{ transform: 'translate(' + pos.x + 'px, ' + pos.y + 'px)' }}
      >
        <div
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return
            setDrag({ sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y })
          }}
          className="px-3 py-2 border-b flex items-center gap-2 shrink-0 cursor-move select-none bg-slate-50 rounded-t"
        >
          <span className="text-sm font-semibold text-slate-700">
            トンボ・丁張計算
            <span className="ml-2 font-mono text-slate-500">{stationLabel}</span>
          </span>
          {/* 測点 送り。 閉じ ず に 隣 の 断面 を 続けて 計算 できる */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                if (!prevStation) return
                onPick(null)
                onSwitchStation(prevStation.id)
              }}
              disabled={!prevStation}
              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-30"
              title="前 の 断面"
            >
              ◀ {prevStation?.label ?? '—'}
            </button>
            <button
              onClick={() => {
                if (!nextStation) return
                onPick(null)
                onSwitchStation(nextStation.id)
              }}
              disabled={!nextStation}
              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-30"
              title="次 の 断面"
            >
              {nextStation?.label ?? '—'} ▶
            </button>
          </div>
          <div className="flex gap-1 ml-2">
            <button onClick={() => setTab('tombo')} className={tabCls(tab === 'tombo')}>
              トンボ {tombos.length > 0 && <span className="opacity-70">{tombos.length}</span>}
            </button>
            <button onClick={() => setTab('chohari')} className={tabCls(tab === 'chohari')}>
              丁張 {chohari.length > 0 && <span className="opacity-70">{chohari.length}</span>}
            </button>
          </div>
          <button onClick={onClose} className="ml-auto p-0.5 hover:bg-slate-100 rounded">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        {picking && (
          <div className="px-3 py-1 text-xs text-pink-700 bg-pink-50 border-b shrink-0">
            {picking.kind === 'tombo'
              ? '① 断面図 の 計画点 (白い 丸) を クリック して ください。'
              : picking.kind === 'choSegment'
                ? '① 対象 の 法面 を クリック。 計画線 の 線分 が 赤く 太く なって います。'
                : picking.kind === 'choBase'
                  ? '② W を 測る 起点 に する 端 を クリック。 線分 の 両端 が 赤い 丸 に なって います。'
                  : '③ 杭 を 立てる 位置 を 図 で クリック。 数値 で 入れる なら W 欄 に 直接 どうぞ。'}
            もう 一度 押す と やめられます。
          </div>
        )}
        {msg && <div className="px-3 py-1 text-xs text-emerald-700 shrink-0">{msg}</div>}

        {tab === 'tombo' ? (
          <>
            <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0 text-xs">
              <button
                onClick={addTombo}
                className="flex items-center gap-1 px-2 py-0.5 border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
              >
                <Plus className="h-3 w-3" />
                トンボ を 足す
              </button>
              <span className="text-slate-400">
                W は 中心 から 遠ざかる 向き が 正、 H は 上 が 正
              </span>
              <button
                onClick={() => void registerTombos()}
                disabled={busy || tomboNotYet.length === 0}
                className="ml-auto flex items-center gap-1 px-2 py-0.5 border rounded bg-violet-600 text-white border-violet-600 hover:bg-violet-700 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                未登録 {tomboNotYet.length} 点 を 座標管理 へ
              </button>
            </div>
            <div className="p-3 overflow-auto">
              {tombos.length === 0 ? (
                <div className="px-2 py-6 text-center text-sm text-slate-400 border rounded">
                  まだ トンボ が ありません。「トンボ を 足す」 から 始めて ください。
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-1 py-1 text-left w-64">基準 の 計画点</th>
                      <th className="px-1 py-1 text-right w-20">W (m)</th>
                      <th className="px-1 py-1 text-right w-20">H (m)</th>
                      <th className="px-1 py-1 text-left w-32">点名</th>
                      <th className="px-1 py-1 text-right w-24">離れ (m)</th>
                      <th className="px-1 py-1 text-right w-24">トンボ高 (m)</th>
                      <th className="px-1 py-1 text-right w-40">座標 (X / Y)</th>
                      <th className="px-1 py-1 w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {tomboRows.map(({ t, r }) => (
                      <tr key={t.id} className="border-t align-top">
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1">
                            {pickButton({ kind: 'tombo', rowId: t.id }, '図で選ぶ')}
                            <span className="min-w-0 truncate text-slate-700">
                              {baseLabel(r?.base ?? null, t.baseOffset)}
                            </span>
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          {numInput(t.id + ':dw', t.dw, (v) =>
                            onChangeTombos(
                              tombos.map((x) => (x.id === t.id ? { ...x, dw: v } : x)),
                            ),
                          )}
                        </td>
                        <td className="px-1 py-1">
                          {numInput(t.id + ':dh', t.dh, (v) =>
                            onChangeTombos(
                              tombos.map((x) => (x.id === t.id ? { ...x, dh: v } : x)),
                            ),
                          )}
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="text"
                            value={t.name ?? ''}
                            onChange={(e) =>
                              onChangeTombos(
                                tombos.map((x) =>
                                  x.id === t.id
                                    ? { ...x, name: e.target.value || undefined }
                                    : x,
                                ),
                              )
                            }
                            placeholder="自動"
                            className="w-full px-1 py-0.5 border rounded text-sm"
                          />
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-slate-700">
                          {r
                            ? (r.offset > 0 ? 'R' : r.offset < 0 ? 'L' : '') +
                              Math.abs(r.offset).toFixed(3)
                            : '-'}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-violet-700 font-semibold">
                          {r ? r.elevation.toFixed(3) : '-'}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-slate-600">
                          {r?.world
                            ? `${r.world.x.toFixed(3)} / ${r.world.y.toFixed(3)}`
                            : '線形 が 未計算'}
                        </td>
                        <td className="px-1 py-1 text-center whitespace-nowrap">
                          {t.coordinateId ? (
                            <span className="text-[11px] text-emerald-700">登録済</span>
                          ) : (
                            <button
                              onClick={() => void registerTombos(t.id)}
                              disabled={busy || !r?.world}
                              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-violet-50 text-violet-700 disabled:opacity-40"
                            >
                              登録
                            </button>
                          )}
                          <button
                            onClick={() =>
                              onChangeTombos(tombos.filter((x) => x.id !== t.id))
                            }
                            className="ml-1 p-0.5 border rounded hover:bg-red-50 text-red-600"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0 text-xs">
              <button
                onClick={addChohari}
                className="flex items-center gap-1 px-2 py-0.5 border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
              >
                <Plus className="h-3 w-3" />
                丁張 を 足す
              </button>
              <span className="text-slate-400">
                ① 線分 → ② 基準点 → ③ 杭 の 位置 の 順 に 図 で 選べます (W は 直接 入力 も 可)
              </span>
              <button
                onClick={() => void registerChohari()}
                disabled={busy || choNotYet.length === 0}
                className="ml-auto flex items-center gap-1 px-2 py-0.5 border rounded bg-rose-600 text-white border-rose-600 hover:bg-rose-700 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                未登録 {choNotYet.length} 点 を 座標管理 へ
              </button>
            </div>
            <div className="p-3 overflow-auto">
              {chohari.length === 0 ? (
                <div className="px-2 py-6 text-center text-sm text-slate-400 border rounded">
                  まだ 丁張 が ありません。「丁張 を 足す」 から 始めて ください。
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-1 py-1 text-left w-64">① 対象 の 法面 (線分)</th>
                      <th className="px-1 py-1 text-left w-52">② 基準点</th>
                      <th className="px-1 py-1 text-left w-44">③ 杭 の 位置 W (m)</th>
                      <th className="px-1 py-1 text-right w-24">杭 の 離れ</th>
                      <th className="px-1 py-1 text-right w-24">丁張高 (m)</th>
                      <th
                        className="px-1 py-1 text-right w-24"
                        title="基準点 から 杭 の 位置 まで の 斜長。 W=0 なら 0"
                      >
                        法長 (m)
                      </th>
                      <th className="px-1 py-1 text-right w-24">法勾配</th>
                      <th className="px-1 py-1 w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {choRows.map(({ c, r }) => (
                      <tr key={c.id} className="border-t align-top">
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1">
                            {pickButton({ kind: 'choSegment', rowId: c.id }, '図で選ぶ')}
                            <span className="min-w-0 truncate text-slate-700">
                              {r?.base && r?.crest
                                ? `${labelOfPoint(r.base)} ― ${labelOfPoint(r.crest)}`
                                : '(線分 が 見つかりません)'}
                            </span>
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1">
                            {pickButton({ kind: 'choBase', rowId: c.id }, '図で選ぶ')}
                            <span className="min-w-0 truncate text-slate-700">
                              {r?.base ? labelOfPoint(r.base) : '-'}
                            </span>
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1">
                            {numInput(c.id + ':w', c.w, (v) =>
                              onChangeChohari(
                                chohari.map((x) => (x.id === c.id ? { ...x, w: v } : x)),
                              ),
                            )}
                            {pickButton({ kind: 'choPos', rowId: c.id }, '図で')}
                          </div>
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-slate-700">
                          {r
                            ? (r.offset > 0 ? 'R' : r.offset < 0 ? 'L' : '') +
                              Math.abs(r.offset).toFixed(3)
                            : '-'}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-rose-700 font-semibold">
                          {r && !r.error ? r.elevation.toFixed(3) : '-'}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-slate-700">
                          {r && !r.error ? r.slopeLength.toFixed(3) : '-'}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums text-slate-700">
                          {r && !r.error ? ratioText(r.factor) : '-'}
                        </td>
                        <td className="px-1 py-1 text-center whitespace-nowrap">
                          {c.coordinateId ? (
                            <span className="text-[11px] text-emerald-700">登録済</span>
                          ) : (
                            <button
                              onClick={() => void registerChohari(c.id)}
                              disabled={busy || !r?.world || !!r?.error}
                              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-rose-50 text-rose-700 disabled:opacity-40"
                            >
                              登録
                            </button>
                          )}
                          <button
                            onClick={() =>
                              onChangeChohari(chohari.filter((x) => x.id !== c.id))
                            }
                            className="ml-1 p-0.5 border rounded hover:bg-red-50 text-red-600"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {choRows.some((x) => x.r?.error) && (
                <div className="mt-2 text-xs text-red-600">
                  {choRows.find((x) => x.r?.error)?.r?.error}
                </div>
              )}
            </div>
          </>
        )}

        <div className="px-3 py-2 border-t flex items-center justify-between shrink-0">
          <span className="text-xs text-slate-400">
            基準 の 点 は 断面図 の 計画点 を クリック して 決めます。
            座標管理 に は 種別「トンボ」/「丁張」、 杭種 も 同じ 名前 で 入ります。
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm border rounded bg-white hover:bg-slate-50 text-slate-600"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
