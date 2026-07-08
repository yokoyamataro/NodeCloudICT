// 工区の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。名前 / 説明 / 着手日 / 完成日 (= 完了) を編集する。
//   モバイルとPCの両方で利用する。

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { Farm } from '@/stores/farmStore'

export function isoToDateInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function dateInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function FarmEditModal({
  farm,
  onUpdateFarm,
  onClose,
}: {
  farm: Farm
  onUpdateFarm: (patch: Partial<Pick<Farm, 'name' | 'description' | 'started_at' | 'completed_at'>>) => void
  onClose: () => void
}) {
  const [name, setName] = useState(farm.name)
  const [description, setDescription] = useState(farm.description ?? '')
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(farm.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(farm.completed_at))

  useEffect(() => {
    setName(farm.name)
    setDescription(farm.description ?? '')
    setStartedAt(isoToDateInput(farm.started_at))
    setCompletedAt(isoToDateInput(farm.completed_at))
  }, [farm.id, farm.name, farm.description, farm.started_at, farm.completed_at])

  const commitName = () => {
    const v = name.trim()
    if (v && v !== farm.name) onUpdateFarm({ name: v })
    else if (!v) setName(farm.name)
  }
  const commitDescription = () => {
    const v = description.trim()
    const prev = farm.description ?? ''
    if (v !== prev) onUpdateFarm({ description: v || null })
  }
  const commitStartedAt = () => {
    const iso = dateInputToIso(startedAt)
    if (iso !== farm.started_at) onUpdateFarm({ started_at: iso })
  }
  const commitCompletedAt = () => {
    const iso = dateInputToIso(completedAt)
    if (iso !== farm.completed_at) onUpdateFarm({ completed_at: iso })
  }

  const isCompleted = farm.completed_at != null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">工区の編集</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-3 overflow-y-auto flex-1 space-y-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">工区名</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              placeholder="任意"
              className="w-full px-2 py-2 border rounded text-sm h-20"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">着手日</label>
            <input
              type="date"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              onBlur={commitStartedAt}
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">進捗 / 完成日</label>
            <label className="flex items-center gap-2 px-2 py-2 border rounded cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={isCompleted}
                onChange={(e) => {
                  if (e.target.checked) {
                    const iso = farm.completed_at ?? new Date().toISOString()
                    onUpdateFarm({ completed_at: iso })
                    setCompletedAt(isoToDateInput(iso))
                  } else {
                    onUpdateFarm({ completed_at: null })
                    setCompletedAt('')
                  }
                }}
                className="h-4 w-4"
              />
              <span className="text-sm">完了</span>
            </label>
            <input
              type="date"
              value={completedAt}
              onChange={(e) => setCompletedAt(e.target.value)}
              onBlur={commitCompletedAt}
              disabled={!isCompleted}
              className="w-full px-2 py-2 border rounded text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
        </div>
        <div className="px-3 py-2 border-t shrink-0">
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 text-sm border rounded-lg hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
