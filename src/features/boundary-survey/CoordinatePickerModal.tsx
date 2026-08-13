// 09 基本三角点等 / 補助基準点 で使う 座標 (測点) 選択モーダル。
// 現 farm の coordinates を一覧表示し、複数選択して 行として取り込む。
// 既に取込済みの座標 ID は 一覧上で disabled 表示。

import { useEffect, useMemo, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'

export interface PickableCoordinate {
  id: string
  pointNumber: string
  stakeType: string | null
  type: string
  x: number
  y: number
  z: number | null
  notes: string | null
}

interface Props {
  farmId: string
  /** すでに取り込み済みの coordinate id 集合 */
  alreadyIn: Set<string>
  title?: string
  onCancel: () => void
  onConfirm: (selected: PickableCoordinate[]) => void
}

const toPickable = (c: CoordinateRow): PickableCoordinate => ({
  id: c.id,
  pointNumber: c.pointNumber,
  stakeType: c.stakeType,
  type: c.type,
  x: c.x,
  y: c.y,
  z: c.z,
  notes: c.notes,
})

export function CoordinatePickerModal({
  farmId,
  alreadyIn,
  title = '測点を選択して取り込み',
  onCancel,
  onConfirm,
}: Props) {
  const coordinates = useCoordinateStore((s) => s.coordinates)
  const loading = useCoordinateStore((s) => s.loading)
  const loadedFarmId = useCoordinateStore((s) => s.loadedFarmId)
  const fetchCoordinates = useCoordinateStore((s) => s.fetchCoordinates as ((farmId: string) => Promise<void>) | undefined)

  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('')

  useEffect(() => {
    // farm 切替時のみロード。fetchCoordinates は farmId 指定 API 前提
    if (loadedFarmId !== farmId && fetchCoordinates) {
      void fetchCoordinates(farmId)
    }
  }, [farmId, loadedFarmId, fetchCoordinates])

  const pickables = useMemo(() => coordinates.map(toPickable), [coordinates])

  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    pickables.forEach((p) => p.type && set.add(p.type))
    return Array.from(set).sort()
  }, [pickables])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return pickables.filter((p) => {
      if (typeFilter && p.type !== typeFilter) return false
      if (!q) return true
      return (
        p.pointNumber.toLowerCase().includes(q) ||
        (p.stakeType ?? '').toLowerCase().includes(q) ||
        (p.notes ?? '').toLowerCase().includes(q)
      )
    })
  }, [pickables, filter, typeFilter])

  const toggle = (id: string) => {
    if (alreadyIn.has(id)) return
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  const toggleAll = () => {
    const availableIds = filtered.filter((p) => !alreadyIn.has(p.id)).map((p) => p.id)
    const allChecked = availableIds.every((id) => checked.has(id))
    const next = new Set(checked)
    if (allChecked) {
      for (const id of availableIds) next.delete(id)
    } else {
      for (const id of availableIds) next.add(id)
    }
    setChecked(next)
  }

  const handleConfirm = () => {
    const selected = pickables.filter((p) => checked.has(p.id))
    onConfirm(selected)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold flex-1">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 hover:bg-slate-100 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3 border-b flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="点番号・杭種・備考でフィルタ"
            className="flex-1 min-w-40 px-2 py-1 text-xs border rounded"
          />
          {typeOptions.length > 0 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 text-xs border rounded bg-white"
            >
              <option value="">全種別</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={toggleAll}
            className="px-2 py-1 text-xs border rounded hover:bg-slate-50"
          >
            表示中を全選択/解除
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : pickables.length === 0 ? (
            <div className="text-xs text-slate-400">
              この工区には 座標データがありません。
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  <th className="w-8 border"></th>
                  <th className="px-2 py-1 border text-left">点番号</th>
                  <th className="px-2 py-1 border text-left">種別</th>
                  <th className="px-2 py-1 border text-left">杭種</th>
                  <th className="px-2 py-1 border text-right">X</th>
                  <th className="px-2 py-1 border text-right">Y</th>
                  <th className="px-2 py-1 border text-left">備考</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const disabled = alreadyIn.has(p.id)
                  const isChecked = checked.has(p.id)
                  return (
                    <tr
                      key={p.id}
                      onClick={() => toggle(p.id)}
                      className={
                        disabled
                          ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          : isChecked
                          ? 'bg-blue-50 cursor-pointer'
                          : 'hover:bg-slate-50 cursor-pointer'
                      }
                    >
                      <td className="border text-center">
                        <input
                          type="checkbox"
                          checked={isChecked || disabled}
                          disabled={disabled}
                          onChange={() => toggle(p.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3.5 w-3.5"
                        />
                      </td>
                      <td className="px-2 py-1 border">{p.pointNumber}</td>
                      <td className="px-2 py-1 border">{p.type}</td>
                      <td className="px-2 py-1 border">{p.stakeType || '—'}</td>
                      <td className="px-2 py-1 border text-right">{p.x.toFixed(3)}</td>
                      <td className="px-2 py-1 border text-right">{p.y.toFixed(3)}</td>
                      <td className="px-2 py-1 border">
                        {p.notes || '—'}
                        {disabled && (
                          <span className="ml-2 text-[10px] text-slate-500">取込済</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t px-4 py-3 flex items-center gap-2">
          <span className="text-xs text-slate-500">{checked.size} 件を選択中</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={checked.size === 0}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> 取り込む
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
