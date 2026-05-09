import { useEffect, useRef, useState } from 'react'

// 左右分割の可変幅レイアウト。
// 左パネル幅(px) を localStorage に保存し、ドラッグで調整できる。
//
// 利用例:
//   <ResizableSplit storageKey="pipe-wiring" defaultLeft={420} minLeft={280} maxLeft={900}
//     left={<DataPanel />}
//     right={<MapPanel />}
//   />

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  /** localStorage キー（ページごとにユニークに） */
  storageKey: string
  /** 既定の左パネル幅(px) */
  defaultLeft?: number
  /** 左パネル最小幅(px) */
  minLeft?: number
  /** 左パネル最大幅(px) */
  maxLeft?: number
  /** ルート div の追加 className */
  className?: string
}

const STORAGE_PREFIX = 'nodecloud_split_'

export function ResizableSplit({
  left,
  right,
  storageKey,
  defaultLeft = 420,
  minLeft = 240,
  maxLeft = 1200,
  className,
}: Props) {
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultLeft
    const saved = window.localStorage.getItem(STORAGE_PREFIX + storageKey)
    if (saved) {
      const n = parseInt(saved, 10)
      if (Number.isFinite(n)) return Math.min(maxLeft, Math.max(minLeft, n))
    }
    return defaultLeft
  })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const clamped = Math.max(minLeft, Math.min(maxLeft, x))
      setLeftWidth(clamped)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        window.localStorage.setItem(STORAGE_PREFIX + storageKey, String(leftWidth))
      } catch {
        // ignore
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [leftWidth, storageKey, minLeft, maxLeft])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const handleDoubleClick = () => {
    setLeftWidth(defaultLeft)
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, String(defaultLeft))
    } catch {
      // ignore
    }
  }

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full overflow-hidden ${className ?? ''}`}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: leftWidth, flex: '0 0 auto' }}
      >
        {left}
      </div>
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className="w-1 cursor-col-resize bg-slate-200 hover:bg-blue-400 transition-colors flex-shrink-0"
        title="ドラッグで幅を調整・ダブルクリックで初期値"
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">{right}</div>
    </div>
  )
}
