// 02 調査した土地 で使う 地番選択モーダル。
// 現 farm 配下の parcels を一覧表示し、複数選択して取り込む。
// 既に 02 に取り込み済みの parcelId は チェック不可 (取込済み表示)。

import { useEffect, useMemo, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export interface PickableParcel {
  id: string
  location: string
  parcelNumber: string
  landCategory: string
  areaSqm: number | null
}

interface Props {
  farmId: string
  /** すでに取り込み済みの parcelId 集合 */
  alreadyIn: Set<string>
  onCancel: () => void
  onConfirm: (selected: PickableParcel[]) => void
}

interface Row {
  id: string
  work_area_id: string
  location: string | null
  parcel_number: string | null
  municipality: string | null
  updated_land_category: string | null
  registered_land_category: string | null
  updated_area_sqm: number | null
  registered_area_sqm: number | null
}

const toParcel = (r: Row): PickableParcel => ({
  id: r.id,
  location: [r.municipality, r.location].filter(Boolean).join(''),
  parcelNumber: r.parcel_number ?? '',
  landCategory: r.updated_land_category ?? r.registered_land_category ?? '',
  areaSqm: r.updated_area_sqm ?? r.registered_area_sqm ?? null,
})

export function ParcelPickerModal({ farmId, alreadyIn, onCancel, onConfirm }: Props) {
  const [parcels, setParcels] = useState<PickableParcel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      const { data: waRows, error: waErr } = await supabase
        .from('design_work_areas')
        .select('id')
        .eq('farm_id', farmId)
        .eq('work_type', 'boundary_survey')
      if (cancelled) return
      if (waErr) {
        setError(waErr.message)
        setLoading(false)
        return
      }
      const waIds = ((waRows ?? []) as { id: string }[]).map((r) => r.id)
      if (waIds.length === 0) {
        setParcels([])
        setLoading(false)
        return
      }
      const { data, error: err } = await supabase
        .from('parcels')
        .select(
          'id, work_area_id, location, parcel_number, municipality, updated_land_category, registered_land_category, updated_area_sqm, registered_area_sqm',
        )
        .in('work_area_id', waIds)
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setParcels(((data ?? []) as Row[]).map(toParcel))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [farmId])

  const filtered = useMemo(() => {
    if (!filter.trim()) return parcels
    const q = filter.trim().toLowerCase()
    return parcels.filter(
      (p) =>
        p.location.toLowerCase().includes(q) ||
        p.parcelNumber.toLowerCase().includes(q) ||
        p.landCategory.toLowerCase().includes(q),
    )
  }, [parcels, filter])

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
    const selected = parcels.filter((p) => checked.has(p.id))
    onConfirm(selected)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold flex-1">地番を選択して取り込み</h3>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 hover:bg-slate-100 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3 border-b flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="所在・地番・地目でフィルタ"
            className="flex-1 px-2 py-1 text-xs border rounded"
          />
          <button
            type="button"
            onClick={toggleAll}
            className="px-2 py-1 text-xs border rounded hover:bg-slate-50"
          >
            表示中を全選択/解除
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3">
          {error ? (
            <div className="text-xs text-red-700">{error}</div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : parcels.length === 0 ? (
            <div className="text-xs text-slate-400">
              この工区には 境界測量の地番データがありません。
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  <th className="w-8 border"></th>
                  <th className="px-2 py-1 border text-left">所在</th>
                  <th className="px-2 py-1 border text-left w-20">地番</th>
                  <th className="px-2 py-1 border text-left w-16">地目</th>
                  <th className="px-2 py-1 border text-right w-24">地積 (㎡)</th>
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
                      className={`${
                        disabled
                          ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          : isChecked
                          ? 'bg-blue-50 cursor-pointer'
                          : 'hover:bg-slate-50 cursor-pointer'
                      }`}
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
                      <td className="px-2 py-1 border">{p.location || '—'}</td>
                      <td className="px-2 py-1 border">{p.parcelNumber || '—'}</td>
                      <td className="px-2 py-1 border">{p.landCategory || '—'}</td>
                      <td className="px-2 py-1 border text-right">
                        {p.areaSqm != null ? p.areaSqm.toFixed(2) : '—'}
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
          <span className="text-xs text-slate-500">
            {checked.size} 件を選択中
          </span>
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
