// 用紙 の 下絵 を 触れる ように した もの。
//
// 自動 で 並べた 要素 は たいてい 良い 所 に 来る が、図面 に よって は
// 重なったり 窮屈 だったり する。 押して 選び、ドラッグ で 動かし、
// 文字 は 大きさ と 角度 も 変えられる ように する。 線 と 文字 を 足す のも ここ。
//
// 直した 分 は frame.overlay に 溜まる。 元 の 並べ方 は 触らない ので、
// 中身 (所在 や 求積 など) を 直せば その まま 追従 する。

import { useMemo, useRef, useState } from 'react'
import { MousePointer2, Pencil, Trash2, Type, Undo2 } from 'lucide-react'
import {
  SHEET,
  applyOverlay,
  type DrawItem,
  type LineStyle,
  type SheetOverlay,
} from './floorPlanDraw'

type Tool = 'select' | 'line' | 'text'

/** 足した 要素 の 識別子。 描画中 で は なく 操作 の 中 で 作る */
let extraSeq = 0
const nextExtraId = () => `extra:${(extraSeq += 1)}-${Math.random().toString(36).slice(2, 7)}`

/** 線種 を SVG の 刻み に */
function svgDash(style: LineStyle | undefined): string | undefined {
  if (style === 'dash') return '1.2 0.8'
  if (style === 'dashdot') return '4 1 0.8 1'
  return undefined
}

/** 要素 の 当たり判定 に 使う おおよそ の 幅 */
function textWidth(it: Extract<DrawItem, { kind: 'text' }>): number {
  const n = Array.from(it.text).length
  return it.pitch && it.pitch > 0 ? it.pitch * (n - 1) + it.h : it.h * n
}

export function FloorPlanSheetEditor({
  items,
  overlay,
  onChange,
}: {
  /** 自動 で 並べた 要素 (手直し を 当てる 前) */
  items: DrawItem[]
  overlay: SheetOverlay | undefined
  onChange: (next: SheetOverlay) => void
}) {
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ id: string; x: number; y: number; dx: number; dy: number } | null>(null)
  const drawRef = useRef<{ x: number; y: number } | null>(null)
  const [rubber, setRubber] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  )

  const shown = useMemo(() => applyOverlay(items, overlay), [items, overlay])
  const extras = overlay?.extras ?? []
  const moves = overlay?.moves ?? {}

  const selected = shown.find((i) => i.id === sel) ?? null
  const isExtra = sel != null && extras.some((e) => e.id === sel)

  const patch = (p: Partial<SheetOverlay>) => onChange({ ...(overlay ?? {}), ...p })
  const patchMove = (id: string, m: { dx?: number; dy?: number; h?: number; rot?: number }) =>
    patch({ moves: { ...moves, [id]: { ...(moves[id] ?? {}), ...m } } })
  const patchExtra = (id: string, next: Partial<DrawItem>) =>
    patch({
      extras: extras.map((e) => (e.id === id ? ({ ...e, ...next } as DrawItem) : e)),
    })

  /** 画面 の 座標 を 用紙 の mm に */
  const toMm = (clientX: number, clientY: number) => {
    const el = svgRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const s = Math.min(r.width / SHEET.w, r.height / SHEET.h)
    return {
      x: (clientX - r.left - (r.width - SHEET.w * s) / 2) / s,
      y: (clientY - r.top - (r.height - SHEET.h * s) / 2) / s,
    }
  }

  const startDrag = (id: string, ev: React.PointerEvent) => {
    if (tool !== 'select') return
    ev.stopPropagation()
    const p = toMm(ev.clientX, ev.clientY)
    const cur = moves[id] ?? {}
    dragRef.current = { id, x: p.x, y: p.y, dx: cur.dx ?? 0, dy: cur.dy ?? 0 }
    setSel(id)
    ;(ev.currentTarget as Element).setPointerCapture?.(ev.pointerId)
  }

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const p = toMm(ev.clientX, ev.clientY)
    if (drawRef.current) {
      setRubber({ x1: drawRef.current.x, y1: drawRef.current.y, x2: p.x, y2: p.y })
      return
    }
    const d = dragRef.current
    if (!d) return
    patchMove(d.id, {
      dx: Math.round((d.dx + p.x - d.x) * 100) / 100,
      dy: Math.round((d.dy + p.y - d.y) * 100) / 100,
    })
  }

  const onDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    const p = toMm(ev.clientX, ev.clientY)
    if (tool === 'line') {
      drawRef.current = p
      setRubber({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
      return
    }
    if (tool === 'text') {
      const t = window.prompt('入れる文字')
      if (t && t.trim()) {
        const id = nextExtraId()
        patch({
          extras: [
            ...extras,
            {
              kind: 'text',
              id,
              x: Math.round(p.x * 100) / 100,
              y: Math.round(p.y * 100) / 100,
              text: t.trim(),
              h: 3,
              anchor: 'start',
              rot: 0,
              layer: '追記',
            },
          ],
        })
        setSel(id)
      }
      setTool('select')
      return
    }
    setSel(null)
  }

  const onUp = () => {
    if (drawRef.current && rubber) {
      const len = Math.hypot(rubber.x2 - rubber.x1, rubber.y2 - rubber.y1)
      if (len > 1) {
        const id = nextExtraId()
        patch({
          extras: [
            ...extras,
            {
              kind: 'line',
              id,
              x1: Math.round(rubber.x1 * 100) / 100,
              y1: Math.round(rubber.y1 * 100) / 100,
              x2: Math.round(rubber.x2 * 100) / 100,
              y2: Math.round(rubber.y2 * 100) / 100,
              w: 0.25,
              layer: '追記',
            },
          ],
        })
        setSel(id)
      }
      setTool('select')
    }
    drawRef.current = null
    dragRef.current = null
    setRubber(null)
  }

  /** 選んだ もの の 囲み */
  const selBox = (() => {
    if (!selected) return null
    if (selected.kind === 'text') {
      const w = textWidth(selected)
      const x =
        selected.anchor === 'middle'
          ? selected.x - w / 2
          : selected.anchor === 'end'
          ? selected.x - w
          : selected.x
      return { x: x - 0.6, y: selected.y - selected.h - 0.4, w: w + 1.2, h: selected.h + 1.4 }
    }
    if (selected.kind === 'line') {
      return {
        x: Math.min(selected.x1, selected.x2) - 1,
        y: Math.min(selected.y1, selected.y2) - 1,
        w: Math.abs(selected.x2 - selected.x1) + 2,
        h: Math.abs(selected.y2 - selected.y1) + 2,
      }
    }
    if (selected.kind === 'circle') {
      return {
        x: selected.cx - selected.r - 0.5,
        y: selected.cy - selected.r - 0.5,
        w: selected.r * 2 + 1,
        h: selected.r * 2 + 1,
      }
    }
    return null
  })()

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 道具 */}
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {(
          [
            ['select', '選択・移動', MousePointer2],
            ['line', '線を引く', Pencil],
            ['text', '文字を足す', Type],
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTool(k)}
            className={`px-2 py-1 text-xs border rounded flex items-center gap-1 ${
              tool === k ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-slate-50'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}

        {selected && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l">
            {selected.kind === 'text' && (
              <>
                <input
                  className="w-40 px-2 py-1 text-xs border rounded"
                  value={selected.text}
                  onChange={(e) =>
                    isExtra
                      ? patchExtra(selected.id!, { text: e.target.value } as Partial<DrawItem>)
                      : undefined
                  }
                  disabled={!isExtra}
                  title={isExtra ? '文字' : '中身は「1 建物情報」などで直します'}
                />
                <label className="text-[11px] text-slate-500">大きさ</label>
                <input
                  type="number"
                  step="0.1"
                  className="w-16 px-1 py-1 text-xs border rounded text-right font-mono"
                  value={selected.h}
                  onChange={(e) => {
                    const v = Math.max(0.5, Number(e.target.value) || 0)
                    if (isExtra) patchExtra(selected.id!, { h: v } as Partial<DrawItem>)
                    else patchMove(selected.id!, { h: v })
                  }}
                />
                <label className="text-[11px] text-slate-500">角度</label>
                <input
                  type="number"
                  step="1"
                  className="w-16 px-1 py-1 text-xs border rounded text-right font-mono"
                  value={selected.rot}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0
                    if (isExtra) patchExtra(selected.id!, { rot: v } as Partial<DrawItem>)
                    else patchMove(selected.id!, { rot: v })
                  }}
                />
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (!sel) return
                if (isExtra) patch({ extras: extras.filter((e) => e.id !== sel) })
                else patch({ hidden: [...(overlay?.hidden ?? []), sel] })
                setSel(null)
              }}
              className="px-2 py-1 text-xs border rounded text-red-600 hover:bg-red-50 flex items-center gap-1"
            >
              <Trash2 className="h-3.5 w-3.5" />
              削除
            </button>
            {!isExtra && (
              <button
                type="button"
                onClick={() => {
                  if (!sel) return
                  const next = { ...moves }
                  delete next[sel]
                  patch({ moves: next })
                }}
                className="px-2 py-1 text-xs border rounded hover:bg-slate-50 flex items-center gap-1"
              >
                <Undo2 className="h-3.5 w-3.5" />
                元に戻す
              </button>
            )}
          </div>
        )}

        {(Object.keys(moves).length > 0 ||
          extras.length > 0 ||
          (overlay?.hidden ?? []).length > 0) && (
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('図枠の手直しをすべて取り消します。よろしいですか？')) return
              onChange({})
              setSel(null)
            }}
            className="ml-auto px-2 py-1 text-xs border rounded hover:bg-slate-50 text-slate-500"
          >
            手直しを全部取り消す
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 border rounded bg-slate-100 p-3 overflow-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SHEET.w} ${SHEET.h}`}
          className="w-full h-auto bg-white shadow select-none"
          preserveAspectRatio="xMidYMid meet"
          style={{ cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          <rect x={0} y={0} width={SHEET.w} height={SHEET.h} fill="#fff" />
          {shown.map((it, i) => {
            const movable = tool === 'select' && it.id != null
            const common = movable
              ? {
                  style: { cursor: 'move' as const },
                  onPointerDown: (ev: React.PointerEvent) => startDrag(it.id!, ev),
                }
              : { pointerEvents: 'none' as const }

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
                  {...common}
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
                  {...common}
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
                  {...common}
                />
              )
            }
            const anchor =
              it.anchor === 'middle' ? 'middle' : it.anchor === 'end' ? 'end' : 'start'
            const transform = it.rot ? `rotate(${-it.rot} ${it.x} ${it.y})` : undefined
            if (it.pitch && it.pitch > 0) {
              const chars = Array.from(it.text)
              const total = it.pitch * (chars.length - 1)
              const start =
                it.anchor === 'middle'
                  ? it.x - total / 2
                  : it.anchor === 'end'
                  ? it.x - total
                  : it.x
              return (
                <g key={i} transform={transform} {...common}>
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
                {...common}
              >
                {it.text}
              </text>
            )
          })}

          {selBox && (
            <rect
              x={selBox.x}
              y={selBox.y}
              width={selBox.w}
              height={selBox.h}
              fill="none"
              stroke="#2563eb"
              strokeWidth={0.3}
              strokeDasharray="1 0.6"
              pointerEvents="none"
            />
          )}
          {rubber && (
            <line
              x1={rubber.x1}
              y1={rubber.y1}
              x2={rubber.x2}
              y2={rubber.y2}
              stroke="#2563eb"
              strokeWidth={0.3}
              pointerEvents="none"
            />
          )}
        </svg>
      </div>

      <div className="mt-1 text-[11px] text-slate-400">
        要素を押して選び、ドラッグで動かします。文字は大きさと角度も変えられます。
        「元に戻す」で 1 つだけ、右の「手直しを全部取り消す」でまとめて戻せます。
      </div>
    </div>
  )
}
