// 設置状態フィルター ボタン + ドロップダウン。
// 座標管理画面と地番管理画面の両方で共有。状態は mapViewStore に乗るので、
// どちらの画面で操作しても両画面の表に・地図に反映される。

import { useEffect, useRef, useState } from 'react'
import { Filter, ChevronDown, Check } from 'lucide-react'
import { useMapViewStore } from '@/stores/mapViewStore'
import {
  STAKE_STATUS_OPTIONS,
  STAKE_STATUS_LABEL,
  STAKE_STATUS_BADGE,
  type StakeStatus,
} from '@/types/database'

interface Props {
  /** ボタンの見た目用 hover クラス（ツールバーの背景と揃える） */
  hoverClass?: string
  /** 表ヘッダ等の狭い場所に収める時のコンパクト表示 */
  compact?: boolean
}

export function StakeStatusFilterButton({
  hoverClass = 'hover:bg-slate-50',
  compact = false,
}: Props) {
  const visible = useMapViewStore((s) => s.visibleStakeStatuses)
  const setVisible = useMapViewStore((s) => s.setVisibleStakeStatuses)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const isAllOn = visible.size === STAKE_STATUS_OPTIONS.length
  return (
    <div className="relative inline-block align-middle" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="設置状態でフィルタ（表と地図の両方）"
        className={
          compact
            ? `inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] rounded border ${hoverClass} ${
                isAllOn ? 'text-slate-400 border-slate-200' : 'text-blue-700 border-blue-300 bg-blue-50'
              }`
            : `flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass}`
        }
      >
        <Filter className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        {compact ? (
          <span className="font-mono">{visible.size}/{STAKE_STATUS_OPTIONS.length}</span>
        ) : (
          <>
            設置状態 ({visible.size}/{STAKE_STATUS_OPTIONS.length})
            <ChevronDown className="h-3 w-3" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-white border rounded shadow-lg z-20 p-2">
          <div className="flex items-center justify-between mb-2 pb-2 border-b">
            <span className="text-xs font-medium text-slate-600">表示する設置状態</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setVisible(new Set<StakeStatus>(STAKE_STATUS_OPTIONS))}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全選択
              </button>
              <button
                type="button"
                onClick={() => setVisible(new Set<StakeStatus>([STAKE_STATUS_OPTIONS[0]]))}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全解除
              </button>
            </div>
          </div>
          <div className="space-y-0.5 max-h-72 overflow-auto">
            {STAKE_STATUS_OPTIONS.map((s) => {
              const on = visible.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    const next = new Set(visible)
                    if (next.has(s)) next.delete(s)
                    else next.add(s)
                    if (next.size === 0) return
                    setVisible(next)
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded ${
                    on ? 'text-slate-800 hover:bg-slate-50' : 'text-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-4 h-4 border rounded ${
                      on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 text-[11px] font-medium border rounded ${STAKE_STATUS_BADGE[s]}`}
                  >
                    {STAKE_STATUS_LABEL[s]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
