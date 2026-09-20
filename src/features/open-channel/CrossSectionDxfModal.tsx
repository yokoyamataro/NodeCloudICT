// 横断図 の DXF 出力。
//
// 用紙 / 縮尺 / DL / 中心位置 は 最初 に 中身 から 自動 で 出し、その まま 直せる。
// 直した 値 で すぐ 出せる ように、枠 と 断面 の 収まり を その場 で 数字 で 見せる。

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { buildDxf, downloadDxf } from '@/lib/dxf'
import {
  PAPER_SIZES,
  SCALE_STEPS,
  buildCrossSectionSheets,
  suggestSheetOptions,
  type SheetSection,
} from '@/lib/openChannel/crossSectionSheetDxf'

/** 数値 入力。 触って いない 間 は 丸めた 値、打って いる 間 は 生 の 文字列 */
function NumField({
  value,
  onCommit,
  step = 1,
  digits = 0,
  suffix,
}: {
  value: number
  onCommit: (v: number) => void
  step?: number
  digits?: number
  suffix?: string
}) {
  const [buf, setBuf] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        value={buf ?? value.toFixed(digits)}
        onFocus={() => setBuf(String(value))}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => {
          const raw = buf
          setBuf(null)
          if (raw == null) return
          const n = parseFloat(raw.trim())
          if (Number.isFinite(n)) onCommit(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        className="w-20 px-1.5 py-1 border rounded text-right font-mono text-xs"
        step={step}
      />
      {suffix && <span className="text-[11px] text-slate-500">{suffix}</span>}
    </span>
  )
}

export function CrossSectionDxfModal({
  channelName,
  sections,
  initialSelected,
  onClose,
}: {
  channelName: string
  /** 出せる 測点 (全部)。 どれ を 出す か は ここ で 選ぶ */
  sections: SheetSection[]
  /** 最初 に チェック して おく 測点 */
  initialSelected?: string[]
  onClose: () => void
}) {
  /** 出す 測点。 空 に は しない (何 も 出ない 出力 を 作らない) */
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initialSelected ?? sections.map((s) => s.id)),
  )
  const chosen = useMemo(() => sections.filter((s) => picked.has(s.id)), [sections, picked])
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const [paper, setPaper] = useState<keyof typeof PAPER_SIZES>('A3')
  const [landscape, setLandscape] = useState(true)
  const base = PAPER_SIZES[paper]
  const paperW = landscape ? base.w : base.h
  const paperH = landscape ? base.h : base.w

  // 自動 の 既定。 用紙 を 変えたら 出し直す
  const auto = useMemo(
    () => suggestSheetOptions(chosen, paperW, paperH),
    [chosen, paperW, paperH],
  )
  /** 手で 直した 分 だけ 覚える。 未設定 は 自動値 */
  const [override, setOverride] = useState<{
    hScale?: number
    vScale?: number
    dl?: number
    centerX?: number
    centerY?: number
  }>({})
  const hScale = override.hScale ?? auto.hScale
  const vScale = override.vScale ?? auto.vScale
  const dl = override.dl ?? auto.dl
  const centerX = override.centerX ?? auto.centerX
  const centerY = override.centerY ?? auto.centerY

  const [showPlanned, setShowPlanned] = useState(true)
  const [showCurrent, setShowCurrent] = useState(true)
  const [showAsbuilt, setShowAsbuilt] = useState(true)

  /** 枠 に 収まる か。 はみ出す なら 数字 で 出す */
  const fit = useMemo(() => {
    const pts = chosen.flatMap((s) => [
      ...(showPlanned ? s.planned : []),
      ...(showCurrent ? s.current : []),
      ...(showAsbuilt ? s.asbuilt : []),
    ])
    if (pts.length === 0) return null
    const half = Math.max(...pts.map((p) => Math.abs(p.offset)))
    const top = Math.max(...pts.map((p) => p.z))
    const low = Math.min(...pts.map((p) => p.z))
    return {
      widthMm: (half * 2 * 1000) / hScale,
      heightMm: ((top - dl) * 1000) / vScale,
      belowDl: low < dl,
      rightMm: centerX + (half * 1000) / hScale,
      topMm: centerY + ((top - dl) * 1000) / vScale,
    }
  }, [chosen, hScale, vScale, dl, centerX, centerY, showPlanned, showCurrent, showAsbuilt])

  const overflow =
    fit != null && (fit.rightMm > paperW || fit.topMm > paperH || centerX - fit.widthMm / 2 < 0)

  const handleExport = () => {
    const entities = buildCrossSectionSheets(chosen, {
      paperW,
      paperH,
      hScale,
      vScale,
      dl,
      centerX,
      centerY,
      showPlanned,
      showCurrent,
      showAsbuilt,
    })
    const safe = channelName.replace(/[^\w\-_]/g, '_')
    downloadDxf(buildDxf(entities), `${safe}_横断図.dxf`)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="px-3 py-2 border-b flex items-center gap-2">
          <h3 className="text-sm font-semibold">横断図 の DXF 出力</h3>
          <span className="text-[11px] text-slate-500">
            {chosen.length} / {sections.length} 測点
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-xs">
          <div className="text-[11px] text-slate-500">
            最初 の 値 は 断面 の 中身 から 出した もの です。 そのまま 直せます。
            1 測点 = 1 枠 で、複数 なら 横 に 並べて 1 ファイル に します。
          </div>

          {/* 出す 測点 */}
          <div className="border rounded">
            <div className="px-2 py-1 bg-slate-50 border-b flex items-center gap-1 flex-wrap">
              <span className="text-slate-500">出す 断面</span>
              <button
                type="button"
                onClick={() => setPicked(new Set(sections.map((s) => s.id)))}
                className="px-1.5 py-0.5 border rounded bg-white text-[11px]"
              >
                全部
              </button>
              <button
                type="button"
                onClick={() =>
                  setPicked(new Set(sections.filter((s) => s.isControl).map((s) => s.id)))
                }
                disabled={!sections.some((s) => s.isControl)}
                className="px-1.5 py-0.5 border rounded bg-white text-[11px] disabled:opacity-40"
              >
                管理測点
              </button>
              <button
                type="button"
                onClick={() => setPicked(new Set())}
                className="px-1.5 py-0.5 border rounded bg-white text-[11px]"
              >
                なし
              </button>
            </div>
            <ul className="max-h-40 overflow-auto divide-y">
              {sections.map((s) => {
                const n =
                  (showPlanned ? (s.planned.length > 0 ? 1 : 0) : 0) +
                  (showCurrent ? (s.current.length > 0 ? 1 : 0) : 0) +
                  (showAsbuilt ? (s.asbuilt.length > 0 ? 1 : 0) : 0)
                return (
                  <li key={s.id}>
                    <label className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={() => togglePick(s.id)}
                      />
                      <span className="font-mono">{s.title}</span>
                      {s.isControl && (
                        <span className="text-[10px] px-1 rounded bg-slate-200 text-slate-600">
                          管理
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-slate-400">
                        計画 {s.planned.length} / 現況 {s.current.length} / 出来形{' '}
                        {s.asbuilt.length}
                      </span>
                      {n === 0 && <span className="text-[10px] text-amber-700">中身なし</span>}
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* 用紙 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-16 shrink-0 text-slate-500">用紙</span>
            <select
              value={paper}
              onChange={(e) => {
                setPaper(e.target.value as keyof typeof PAPER_SIZES)
                setOverride({})
              }}
              className="px-2 py-1 border rounded"
            >
              {Object.keys(PAPER_SIZES).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={landscape}
                onChange={(e) => {
                  setLandscape(e.target.checked)
                  setOverride({})
                }}
              />
              <span>横置き</span>
            </label>
            <span className="text-slate-400 font-mono">
              {paperW} × {paperH} mm
            </span>
          </div>

          {/* 縮尺 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-16 shrink-0 text-slate-500">縮尺</span>
            <label className="flex items-center gap-1">
              <span className="text-slate-400">横 1:</span>
              <select
                value={hScale}
                onChange={(e) => setOverride((o) => ({ ...o, hScale: Number(e.target.value) }))}
                className="px-2 py-1 border rounded font-mono"
              >
                {SCALE_STEPS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400">縦 1:</span>
              <select
                value={vScale}
                onChange={(e) => setOverride((o) => ({ ...o, vScale: Number(e.target.value) }))}
                className="px-2 py-1 border rounded font-mono"
              >
                {SCALE_STEPS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* DL */}
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-slate-500">DL</span>
            <NumField
              value={dl}
              digits={3}
              step={0.5}
              suffix="m"
              onCommit={(v) => setOverride((o) => ({ ...o, dl: v }))}
            />
            <span className="text-[11px] text-slate-400">高さ の 読み 始め</span>
          </div>

          {/* 中心位置 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-16 shrink-0 text-slate-500">中心位置</span>
            <NumField
              value={centerX}
              suffix="mm"
              onCommit={(v) => setOverride((o) => ({ ...o, centerX: v }))}
            />
            <NumField
              value={centerY}
              suffix="mm"
              onCommit={(v) => setOverride((o) => ({ ...o, centerY: v }))}
            />
            <span className="text-[11px] text-slate-400">中心線 と DL の 交点 (左下 原点)</span>
          </div>

          {/* 出す もの */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="w-16 shrink-0 text-slate-500">出す線</span>
            {(
              [
                ['計画', showPlanned, setShowPlanned],
                ['現況', showCurrent, setShowCurrent],
                ['出来形', showAsbuilt, setShowAsbuilt],
              ] as const
            ).map(([label, v, set]) => (
              <label key={label} className="flex items-center gap-1">
                <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {/* 収まり */}
          {fit && (
            <div
              className={`rounded border p-2 space-y-0.5 font-mono text-[11px] ${
                overflow
                  ? 'bg-amber-50 border-amber-300 text-amber-800'
                  : 'bg-slate-50 border-slate-200 text-slate-600'
              }`}
            >
              <div>
                断面 の 大きさ 横 {fit.widthMm.toFixed(0)} mm / 縦 {fit.heightMm.toFixed(0)} mm
              </div>
              <div>
                右端 {fit.rightMm.toFixed(0)} mm / 上端 {fit.topMm.toFixed(0)} mm (用紙 {paperW} ×{' '}
                {paperH})
              </div>
              {overflow && <div className="font-sans">枠 から はみ出します。 縮尺 か 中心位置 を 直して ください。</div>}
              {fit.belowDl && (
                <div className="font-sans text-amber-800">DL より 下 に 点 が あります。</div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setOverride({})}
            className="text-[11px] text-blue-700 underline"
          >
            自動 の 値 に 戻す
          </button>
        </div>

        <div className="px-3 py-2 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs border rounded bg-white">
            閉じる
          </button>
          <button
            onClick={handleExport}
            disabled={chosen.length === 0}
            className="ml-auto px-3 py-1.5 text-xs rounded bg-blue-600 text-white disabled:opacity-40"
          >
            DXF を 出力
          </button>
        </div>
      </div>
    </div>
  )
}
