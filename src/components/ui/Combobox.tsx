// シンプルなコンボボックス。ネイティブ <select> と違って、テキスト入力で
// 部分一致のインクリメンタル検索ができる。
//
// 使い方:
//   const options = [{ value: '01', label: '北海道' }, ...]
//   <Combobox value={code} onChange={setCode} options={options}
//             placeholder="都道府県" />
//
// キーボード:
//   ↑ ↓ でハイライト移動、Enter で確定、Esc で閉じる
//
// blur で閉じる仕様だが、リスト内クリック時に blur が先に発火して選択できなく
// なる問題を防ぐため、リストは onMouseDown で選択している (blur より先に走る)。

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react'
import { ChevronDown } from 'lucide-react'

export interface ComboboxOption {
  value: string
  label: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  /** リストで一度に表示する最大件数 (default 200) */
  maxVisible?: number
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = '',
  maxVisible = 200,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string>('')
  const [highlight, setHighlight] = useState<number>(-1)

  const selectedLabel = useMemo(() => {
    const hit = options.find((o) => o.value === value)
    return hit ? hit.label : ''
  }, [options, value])

  // 値が外部から変更されたら、閉じてる時は入力欄に選択ラベルを表示するために query をリセット
  useEffect(() => {
    if (!open) setQuery('')
  }, [value, open])

  // 表示用フィルタリング
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  const visible = filtered.slice(0, maxVisible)

  // ハイライトを filtered の範囲内に収める
  useEffect(() => {
    if (visible.length === 0) {
      setHighlight(-1)
    } else if (highlight < 0 || highlight >= visible.length) {
      setHighlight(0)
    }
  }, [visible, highlight])

  const displayValue = open ? query : selectedLabel

  const handleFocus = () => {
    if (disabled) return
    setOpen(true)
    setQuery('')
  }

  const handleBlur = () => {
    // blur が発火するタイミングで既にリスト内 mousedown が走って選択済みなので、
    // ここで閉じるだけで良い。
    setOpen(false)
    setQuery('')
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    if (!open) setOpen(true)
  }

  const handleSelect = (opt: ComboboxOption) => {
    onChange(opt.value)
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setHighlight((h) => Math.min(h + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && visible[highlight]) {
        e.preventDefault()
        handleSelect(visible[highlight])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
      inputRef.current?.blur()
    }
  }

  return (
    <div className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full pl-3 pr-8 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
        autoComplete="off"
      />
      <ChevronDown className="h-4 w-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      {open && !disabled && (
        <ul
          className="absolute z-[3100] top-full left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-300 rounded shadow-lg text-sm"
          role="listbox"
        >
          {visible.length === 0 ? (
            <li className="px-3 py-2 text-slate-400">該当なし</li>
          ) : (
            visible.map((opt, i) => (
              <li
                key={opt.value}
                onMouseDown={(e) => {
                  // blur より先に選択したいので mousedown で確定
                  e.preventDefault()
                  handleSelect(opt)
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`px-3 py-1.5 cursor-pointer ${
                  i === highlight
                    ? 'bg-blue-50 text-blue-800'
                    : 'hover:bg-slate-50'
                }`}
                role="option"
                aria-selected={value === opt.value}
              >
                {opt.label}
              </li>
            ))
          )}
          {filtered.length > maxVisible && (
            <li className="px-3 py-1 text-[11px] text-amber-700 bg-amber-50 border-t">
              先頭 {maxVisible.toLocaleString()} 件表示。入力で絞り込んでください。
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
