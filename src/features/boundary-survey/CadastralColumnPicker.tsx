// 地番一覧の上に出す「表示列選択」ボタン + ドロップダウン。
// 選択は localStorage に保存し、リロード後も維持する。

import { useEffect, useRef, useState } from 'react'
import { Columns3, Check } from 'lucide-react'
import {
  CADASTRAL_COLUMN_KEYS,
  CADASTRAL_COLUMN_LABELS,
  DEFAULT_VISIBLE_COLUMNS,
  type CadastralColumnKey,
} from './CadastralRowFields'

const STORAGE_KEY = 'cadastral:visibleColumns'

function load(): Set<CadastralColumnKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set(DEFAULT_VISIBLE_COLUMNS)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set(DEFAULT_VISIBLE_COLUMNS)
    const valid = arr.filter((k): k is CadastralColumnKey =>
      (CADASTRAL_COLUMN_KEYS as readonly string[]).includes(k),
    )
    // 空配列で全部消えるのは事故っぽいので、最低 1 列は残す
    return valid.length > 0 ? new Set(valid) : new Set(DEFAULT_VISIBLE_COLUMNS)
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS)
  }
}

function save(set: Set<CadastralColumnKey>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    /* ignore */
  }
}

export function useCadastralVisibleColumns(): [
  Set<CadastralColumnKey>,
  (next: Set<CadastralColumnKey>) => void,
] {
  const [visible, setVisible] = useState<Set<CadastralColumnKey>>(() => load())
  const update = (next: Set<CadastralColumnKey>) => {
    setVisible(next)
    save(next)
  }
  return [visible, update]
}

interface PickerProps {
  visible: Set<CadastralColumnKey>
  onChange: (next: Set<CadastralColumnKey>) => void
}

export function CadastralColumnPicker({ visible, onChange }: PickerProps) {
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

  const toggle = (key: CadastralColumnKey) => {
    const next = new Set(visible)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    // 全部 OFF にならないようガード（最後の 1 つは消さない）
    if (next.size === 0) return
    onChange(next)
  }

  const setAll = (on: boolean) => {
    onChange(on ? new Set(CADASTRAL_COLUMN_KEYS) : new Set([CADASTRAL_COLUMN_KEYS[0]]))
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        title="表示列を選択"
      >
        <Columns3 className="h-3.5 w-3.5" />
        表示列 ({visible.size}/{CADASTRAL_COLUMN_KEYS.length})
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-white border rounded shadow-lg z-20 p-2">
          <div className="flex items-center justify-between mb-2 pb-2 border-b">
            <span className="text-xs font-medium text-slate-600">表示する列</span>
            <div className="flex gap-1">
              <button
                onClick={() => setAll(true)}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全選択
              </button>
              <button
                onClick={() => setAll(false)}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全解除
              </button>
            </div>
          </div>
          <div className="space-y-0.5 max-h-72 overflow-auto">
            {CADASTRAL_COLUMN_KEYS.map((key) => {
              const on = visible.has(key)
              return (
                <button
                  key={key}
                  onClick={() => toggle(key)}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded ${
                    on ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-4 h-4 border rounded ${
                      on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span>{CADASTRAL_COLUMN_LABELS[key]}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
