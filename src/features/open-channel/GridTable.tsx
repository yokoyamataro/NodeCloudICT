import { useState } from 'react'
import { Pencil, ClipboardPaste, Copy } from 'lucide-react'
import type { GridLinesConfig, MeasuredCrossPoint, StationRow } from '@/stores/openChannelStore'
import {
  gridLineIndices,
  gridLineName,
  gridLineOffset,
  gridPointName,
} from '@/lib/openChannel/gridLines'
import { pointNearOffset } from '@/lib/openChannel/gridLines'
import { alignTsvToGrid, gridToTsv } from '@/lib/openChannel/gridPaste'

/** 格子 の 点 と みなす 離れ の 許容 [m]。 実測 から 拾った 点 の ずれ を 吸収 する */
export const GRID_TOLERANCE_M = 0.5

/** 選んで いる 格子点。 地図 と 突き合わせる ため に 親 が 持つ */
export interface GridCellRef {
  stationId: string
  /** 中心 から の 本数 (左 が 負) */
  idx: number
}

/** 表 に 出す 高さ の 種類。 diff は 計画 − 現況 の 読み取り 専用 */
type GridTarget = 'current' | 'planned' | 'asbuilt'
type GridView = GridTarget | 'diff'

const VIEWS: { key: GridView; label: string; cell: string }[] = [
  { key: 'current', label: '現況', cell: 'text-amber-700 bg-amber-50/40' },
  { key: 'planned', label: '計画', cell: 'text-sky-700 bg-sky-50/40' },
  { key: 'asbuilt', label: '出来形', cell: 'text-emerald-700 bg-emerald-50/40' },
  { key: 'diff', label: '切盛', cell: '' },
]

/** 数値 の 欄。 打って いる 間 は 文字 を 残し、 離れた とき に 確定 する */
function HeightCell({
  value,
  onCommit,
  onSelect,
  className,
}: {
  value: number | null
  onCommit: (v: number | null) => void
  /** 触られた とき。 地図 に 出す 点 を 決める */
  onSelect?: () => void
  className?: string
}) {
  const [buf, setBuf] = useState<string | null>(null)
  const shown = buf ?? (value == null ? '' : value.toFixed(3))
  const commit = () => {
    if (buf == null) return
    const raw = buf.trim()
    setBuf(null)
    if (raw === '') {
      if (value != null) onCommit(null)
      return
    }
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return
    const r = Math.round(n * 1000) / 1000
    if (r !== value) onCommit(r)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      onFocus={() => {
        setBuf(value == null ? '' : String(value))
        onSelect?.()
      }}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setBuf(null)
      }}
      className={
        'w-[4.5rem] px-1 py-0.5 border rounded text-right tabular-nums text-sm ' + (className ?? '')
      }
    />
  )
}

/**
 * 整地 の グリッド表。
 *
 * 行 が 測点 (横断)、 列 が 中心線 と 平行 な 縦断。 交点 が 格子点 の 高さ。
 * 高さ の 実体 は 各 測点 の 横断 の 点列 そのもの な ので、 ここ で 直した 値 は
 * 横断 の 同じ 点 に そのまま 入る。 列 を 縦 に 読めば 平行 縦断 に なる。
 */
export function GridTable({
  cfg,
  stations,
  spOffset,
  onChangeCfg,
  resolveCurrent,
  onSetHeight,
  selectedCell,
  onSelectCell,
  selectedStationId,
  onSelectStation,
  selectedLineIdx,
  onSelectLine,
  onPasteCells,
}: {
  cfg: GridLinesConfig
  /** 距離 順 に 並んだ 測点 */
  stations: StationRow[]
  spOffset: number
  onChangeCfg: (next: GridLinesConfig) => void
  /** 測点 の 現況 点列。 保存 が 無ければ 実測記録 から 拾った もの を 返す */
  resolveCurrent: (st: StationRow) => MeasuredCrossPoint[]
  /** 格子点 の 高さ を 書く (null で 消す) */
  onSetHeight: (
    stationId: string,
    target: GridTarget,
    offset: number,
    elevation: number | null,
  ) => void
  /** いま 地図 に 出して いる 格子点 */
  selectedCell: GridCellRef | null
  onSelectCell: (cell: GridCellRef | null) => void
  /** 横断図 に 出して いる 測点。 行 (測点 の セル) を 押す と 変わる */
  selectedStationId: string | null
  onSelectStation: (stationId: string) => void
  /** 縦断図 に 出して いる 線。 列 の 見出し を 押す と 変わる */
  selectedLineIdx: number | null
  onSelectLine: (idx: number) => void
  /** 表計算 から の 貼り付け。 まとめて 1 回 で 保存 する */
  onPasteCells: (
    cells: { stationId: string; idx: number; value: number | null }[],
    target: GridTarget,
  ) => void
}) {
  const [view, setView] = useState<GridView>('current')
  const [editingCfg, setEditingCfg] = useState(false)
  const indices = gridLineIndices(cfg)
  const viewDef = VIEWS.find((v) => v.key === view) ?? VIEWS[0]

  /** 測点 × 離れ の 高さ を 引く */
  const heightAt = (st: StationRow, target: GridTarget, offset: number): number | null => {
    const src =
      target === 'current'
        ? resolveCurrent(st)
        : target === 'planned'
          ? (st.plannedSectionRaw ?? [])
          : (st.asbuiltSection ?? [])
    return pointNearOffset(src, offset, GRID_TOLERANCE_M)?.elevation ?? null
  }

  /** 表計算 と の やり取り */
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [msg, setMsg] = useState('')

  /** 表 の 値 を 1 つ 引く (コピー 用)。 切盛 は 計画 − 現況 */
  const valueAt = (row: number, col: number): number | null => {
    const st = stations[row]
    if (!st) return null
    const offset = gridLineOffset(cfg, indices[col])
    if (view === 'diff') {
      const p = heightAt(st, 'planned', offset)
      const c = heightAt(st, 'current', offset)
      return p != null && c != null ? Math.round((p - c) * 1000) / 1000 : null
    }
    return heightAt(st, view, offset)
  }

  const lineNames = indices.map((i) => gridLineName(cfg, i))
  const stationLabels = stations.map((st) => st.label)

  const handleCopy = async () => {
    const tsv = gridToTsv(lineNames, stationLabels, valueAt)
    try {
      await navigator.clipboard.writeText(tsv)
      setMsg(`${viewDef.label} の 表 を コピー しました。`)
    } catch {
      // 権限 が 無い 環境 でも 拾えるように 貼り付け 欄 に 出す
      setPasteOpen(true)
      setPasteText(tsv)
      setMsg('コピー できません でした。 下 の 欄 の 中身 を 選んで コピー して ください。')
    }
  }

  /** 貼り付け た 文字列 を 表 に 入れる */
  const applyPaste = (text: string) => {
    if (view === 'diff') {
      setMsg('切盛 は 計算 結果 な ので 貼り付け られません。 現況 / 計画 / 出来形 を 選んで ください。')
      return
    }
    if (text.trim() === '') return
    const anchorRow = selectedCell
      ? Math.max(0, stations.findIndex((st) => st.id === selectedCell.stationId))
      : 0
    const anchorCol = selectedCell ? Math.max(0, indices.indexOf(selectedCell.idx)) : 0
    const r = alignTsvToGrid(text, { lineNames, stationLabels, anchorRow, anchorCol })
    if (r.cells.length === 0) {
      setMsg(`入れられる 値 が ありません でした${r.skipped > 0 ? ` (${r.skipped} 件 飛ばし)` : ''}。`)
      return
    }
    onPasteCells(
      r.cells.map((c) => ({
        stationId: stations[c.row].id,
        idx: indices[c.col],
        value: c.value,
      })),
      view,
    )
    const how = r.usedHeader
      ? '見出し で 突き合わせ'
      : r.usedLabels
        ? '測点名 で 突き合わせ'
        : '選んだ セル を 左上 に して'
    setMsg(
      `${how}、 ${viewDef.label} に ${r.cells.length} 点 入れました` +
        (r.skipped > 0 ? ` (${r.skipped} 件 飛ばし)` : '') +
        '。',
    )
    setPasteOpen(false)
    setPasteText('')
  }

  /** 選んで いる セル の 呼び名 (例 H+80)。 地図 の ラベル と 揃える */
  const selectedPointName = (() => {
    if (!selectedCell) return null
    const st = stations.find((x) => x.id === selectedCell.stationId)
    if (!st) return null
    return gridPointName(gridLineName(cfg, selectedCell.idx), st.distance + spOffset)
  })()

  const renameLine = (idx: number) => {
    const cur = gridLineName(cfg, idx)
    const v = window.prompt('線 の 名前 (空 に する と 自動 に 戻す)', cur)
    if (v == null) return
    const names = { ...(cfg.names ?? {}) }
    if (v.trim() === '') delete names[String(idx)]
    else names[String(idx)] = v.trim()
    onChangeCfg({ ...cfg, names: Object.keys(names).length > 0 ? names : undefined })
  }

  const numField = (
    label: string,
    value: number,
    min: number,
    apply: (v: number) => void,
  ) => (
    <label className="flex items-center gap-1 text-xs text-slate-600">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={1}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v) && v >= min) apply(Math.floor(v))
        }}
        className="w-14 px-1 py-0.5 border rounded text-right text-xs"
      />
    </label>
  )

  return (
    <>
      {/* 出す 高さ の 種類。 切盛 だけ は 読み取り */}
      <div className="flex items-center gap-1 flex-wrap">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={
              'px-2 py-0.5 text-xs border rounded ' +
              (v.key === view
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white hover:bg-slate-50 text-slate-700')
            }
            title={v.key === 'diff' ? '計画 − 現況。 + が 盛土、 − が 切土' : undefined}
          >
            {v.label}
          </button>
        ))}
        {/* 選んで いる 格子点 の 呼び名。 地図 の ラベル と 同じ 形 */}
        {selectedPointName && (
          <span className="px-2 py-0.5 text-xs rounded bg-orange-100 text-orange-800 font-mono">
            {selectedPointName}
          </span>
        )}
        <button
          onClick={() => void handleCopy()}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
          title="表 を TSV で コピー (表計算 に そのまま 貼れます)"
        >
          <Copy className="h-3 w-3" />
          コピー
        </button>
        <button
          onClick={() => {
            setPasteOpen((x) => !x)
            setMsg('')
          }}
          className={
            'flex items-center gap-1 px-2 py-0.5 text-xs border rounded ' +
            (pasteOpen ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50 text-slate-600')
          }
          title="表計算 から の 貼り付け。 表 の 上 で Ctrl+V でも 入ります"
        >
          <ClipboardPaste className="h-3 w-3" />
          貼り付け
        </button>
        <button
          onClick={() => setEditingCfg((x) => !x)}
          className="flex items-center gap-1 px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
          title="中心 の 名前 / 本数"
        >
          <Pencil className="h-3 w-3" />
          格子 の 設定
        </button>
      </div>

      {editingCfg && (
        <div className="flex items-center gap-3 flex-wrap border rounded bg-slate-50 px-2 py-1.5">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>中心 の 名前</span>
            <input
              type="text"
              value={cfg.centerName}
              onChange={(e) =>
                onChangeCfg({ ...cfg, centerName: e.target.value.trim() || cfg.centerName })
              }
              className="w-14 px-1 py-0.5 border rounded text-center text-xs font-mono"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>名前 の 向き</span>
            <select
              value={cfg.reverseNames ? 'left' : 'right'}
              onChange={(e) => onChangeCfg({ ...cfg, reverseNames: e.target.value === 'left' })}
              className="px-1 py-0.5 border rounded text-xs"
              title="アルファベット が 右 へ 進む か 左 へ 進む か"
            >
              <option value="right">右 へ 進む (…E {cfg.centerName} G…)</option>
              <option value="left">左 へ 進む (…G {cfg.centerName} E…)</option>
            </select>
          </label>
          {numField('左 (本)', cfg.leftCount, 0, (v) => onChangeCfg({ ...cfg, leftCount: v }))}
          {numField('右 (本)', cfg.rightCount, 0, (v) => onChangeCfg({ ...cfg, rightCount: v }))}
          <span className="text-[11px] text-slate-400">
            本数 は グリッドを計算 で 工事区域 から 決まります。 列 の 名前 は 見出し を
            ダブルクリック で 変えられます。
          </span>
        </div>
      )}

      {pasteOpen && (
        <div className="border rounded bg-slate-50 px-2 py-1.5 space-y-1">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            placeholder={'表計算 から コピー して ここ に 貼り付け (Ctrl+V) → 取込\n1 行目 に 線名、 1 列目 に 測点名 が あれば 名前 で 合わせます'}
            className="w-full px-2 py-1 border rounded text-xs font-mono"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => applyPaste(pasteText)}
              disabled={pasteText.trim() === ''}
              className="px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {viewDef.label} に 取込
            </button>
            <button
              onClick={() => {
                setPasteOpen(false)
                setPasteText('')
              }}
              className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
            >
              閉じる
            </button>
            <span className="text-[11px] text-slate-400">空 の セル は 消します</span>
          </div>
        </div>
      )}

      {msg && <div className="text-[11px] text-slate-600">{msg}</div>}

      {/* 行 = 測点、 列 = 平行 縦断。 測点 の 列 だけ 左 に 貼り付ける。
          表 の 上 で の Ctrl+V は 選んで いる セル を 左上 に して 流し込む。 */}
      <div
        className="border rounded overflow-auto max-h-96"
        onPaste={(e) => {
          const text = e.clipboardData?.getData('text/plain') ?? ''
          if (!text.includes('\t') && !text.includes('\n')) return
          e.preventDefault()
          applyPaste(text)
        }}
      >
        <table className="text-sm border-separate border-spacing-0">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-slate-50 px-2 py-1 text-left border-b border-r">
                測点
              </th>
              {indices.map((i) => (
                <th
                  key={i}
                  onClick={() => onSelectLine(i)}
                  onDoubleClick={() => renameLine(i)}
                  title={`離れ ${gridLineOffset(cfg, i).toFixed(1)}m — 押す と この 線 の 縦断 (ダブルクリック で 改名)`}
                  className={
                    'sticky top-0 z-10 px-1 py-1 text-center font-mono border-b cursor-pointer select-none ' +
                    (selectedLineIdx === i
                      ? 'bg-sky-200 '
                      : selectedCell?.idx === i
                        ? 'bg-orange-100 '
                        : 'bg-slate-50 ') +
                    (i === 0 ? 'text-sky-800 font-semibold' : '')
                  }
                >
                  {gridLineName(cfg, i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stations.length === 0 && (
              <tr>
                <td
                  colSpan={indices.length + 1}
                  className="px-2 py-4 text-center text-xs text-slate-400"
                >
                  グリッドを計算 を 押す と 測点 と 格子 が できます。
                </td>
              </tr>
            )}
            {stations.map((st) => (
              <tr key={st.id}>
                <td
                  onClick={() => onSelectStation(st.id)}
                  title="押す と この 測点 の 横断図"
                  className={
                    'sticky left-0 z-10 px-2 py-1 font-mono text-slate-700 whitespace-nowrap border-b border-r cursor-pointer ' +
                    (selectedStationId === st.id
                      ? 'bg-sky-200'
                      : selectedCell?.stationId === st.id
                        ? 'bg-orange-100'
                        : 'bg-white hover:bg-slate-50')
                  }
                >
                  {st.label}
                </td>
                {indices.map((i) => {
                  const offset = gridLineOffset(cfg, i)
                  if (view === 'diff') {
                    const planned = heightAt(st, 'planned', offset)
                    const current = heightAt(st, 'current', offset)
                    const d = planned != null && current != null ? planned - current : null
                    return (
                      <td
                        key={i}
                        onClick={() => onSelectCell({ stationId: st.id, idx: i })}
                        className={
                          'px-2 py-1 text-right tabular-nums border-b cursor-pointer ' +
                          (selectedCell?.stationId === st.id && selectedCell.idx === i
                            ? 'ring-2 ring-inset ring-orange-500 '
                            : '') +
                          (d == null
                            ? 'text-slate-300'
                            : d > 0.0005
                              ? 'text-red-600'
                              : d < -0.0005
                                ? 'text-blue-600'
                                : 'text-slate-500')
                        }
                      >
                        {d == null ? '-' : (d > 0 ? '+' : '') + d.toFixed(3)}
                      </td>
                    )
                  }
                  return (
                    <td key={i} className="px-1 py-1 border-b">
                      <HeightCell
                        value={heightAt(st, view, offset)}
                        onCommit={(v) => onSetHeight(st.id, view, offset, v)}
                        onSelect={() => onSelectCell({ stationId: st.id, idx: i })}
                        className={
                          viewDef.cell +
                          (selectedCell?.stationId === st.id && selectedCell.idx === i
                            ? ' ring-2 ring-orange-500 border-orange-400'
                            : '')
                        }
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
