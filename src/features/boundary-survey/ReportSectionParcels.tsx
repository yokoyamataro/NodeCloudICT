// 02 調査した土地
//   * 地番 1..n (可変行)
//   * 「地番から取り込み」で 現 farm の parcels を 一括読込 + 手入力修正
//   * 各行: 所在 / 地番 / 地目 / 地積 / 第三者権利有無 / 用途 / 地積測量図有無

import { Plus, Trash2, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from '@/stores/farmStore'
import type { LandReportBody, ReportParcelRow } from '@/stores/landReportStore'
import { RadioGroup } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

interface ParcelRow {
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

const emptyRow = (appNo: number): ReportParcelRow => ({
  appNo,
  parcelId: null,
  location: '',
  parcelNumber: '',
  landCategory: '',
  areaSqm: null,
  hasThirdPartyRight: null,
  usage: '',
  hasSurveyMap: null,
})

export function ReportSectionParcels({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [importing, setImporting] = useState(false)
  const [available, setAvailable] = useState<ParcelRow[]>([])

  const rows = body.parcels

  const setRows = (next: ReportParcelRow[]) => {
    onChange({ parcels: next.map((r, i) => ({ ...r, appNo: i + 1 })) })
  }

  const patchRow = (idx: number, patch: Partial<ReportParcelRow>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  // 現 farm の parcels を取得 (最初にモーダルを開いた時)
  useEffect(() => {
    if (!currentFarm?.id) return
    let cancelled = false
    ;(async () => {
      const { data: waRows } = await supabase
        .from('design_work_areas')
        .select('id')
        .eq('farm_id', currentFarm.id)
        .eq('work_type', 'boundary_survey')
      const waIds = ((waRows ?? []) as { id: string }[]).map((r) => r.id)
      if (waIds.length === 0) {
        if (!cancelled) setAvailable([])
        return
      }
      const { data } = await supabase
        .from('parcels')
        .select(
          'id, work_area_id, location, parcel_number, municipality, updated_land_category, registered_land_category, updated_area_sqm, registered_area_sqm',
        )
        .in('work_area_id', waIds)
      if (!cancelled) setAvailable((data ?? []) as ParcelRow[])
    })()
    return () => {
      cancelled = true
    }
  }, [currentFarm?.id])

  const importAll = () => {
    setImporting(true)
    const alreadyById = new Set(rows.map((r) => r.parcelId).filter(Boolean))
    const additions: ReportParcelRow[] = available
      .filter((p) => !alreadyById.has(p.id))
      .map((p, i) => ({
        appNo: rows.length + i + 1,
        parcelId: p.id,
        location: [p.municipality, p.location].filter(Boolean).join(''),
        parcelNumber: p.parcel_number ?? '',
        landCategory:
          p.updated_land_category ?? p.registered_land_category ?? '',
        areaSqm: p.updated_area_sqm ?? p.registered_area_sqm ?? null,
        hasThirdPartyRight: null,
        usage: '',
        hasSurveyMap: null,
      }))
    setRows([...rows, ...additions])
    setImporting(false)
  }

  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={importAll}
          disabled={importing || available.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
          title={
            available.length === 0
              ? 'この工区には 境界測量の地番データがありません'
              : `${available.length} 件の地番から未取込を追加`
          }
        >
          <Download className="h-3 w-3" />
          地番から取り込み ({available.length})
        </button>
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        >
          <Plus className="h-3 w-3" /> 手動で追加
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">
          調査対象の地番がありません。「地番から取り込み」または「手動で追加」で行を作成してください。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-1 py-1 border w-8">#</th>
                <th className="px-1 py-1 border text-left">所在</th>
                <th className="px-1 py-1 border text-left w-20">地番</th>
                <th className="px-1 py-1 border text-left w-16">地目</th>
                <th className="px-1 py-1 border text-right w-24">地積 (㎡)</th>
                <th className="px-1 py-1 border text-left w-24">第三者権利</th>
                <th className="px-1 py-1 border text-left w-24">用途</th>
                <th className="px-1 py-1 border text-left w-24">地積測量図</th>
                <th className="w-8 border"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx} className="hover:bg-slate-50">
                  <td className="px-1 py-0.5 border text-center">{idx + 1}</td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.location}
                      onChange={(e) => patchRow(idx, { location: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.parcelNumber}
                      onChange={(e) => patchRow(idx, { parcelNumber: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.landCategory}
                      onChange={(e) => patchRow(idx, { landCategory: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="number"
                      step="0.01"
                      value={r.areaSqm ?? ''}
                      onChange={(e) =>
                        patchRow(idx, {
                          areaSqm: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      className="w-full px-1 py-0.5 border rounded text-right"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <RadioGroup
                      name={`thirdParty-${idx}`}
                      value={
                        r.hasThirdPartyRight === true
                          ? 'yes'
                          : r.hasThirdPartyRight === false
                          ? 'no'
                          : null
                      }
                      onChange={(v) =>
                        patchRow(idx, {
                          hasThirdPartyRight: v === 'yes' ? true : v === 'no' ? false : null,
                        })
                      }
                      options={[
                        { value: 'yes', label: '有' },
                        { value: 'no', label: '無' },
                      ]}
                      allowNull={false}
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.usage}
                      onChange={(e) => patchRow(idx, { usage: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <RadioGroup
                      name={`surveyMap-${idx}`}
                      value={
                        r.hasSurveyMap === true
                          ? 'yes'
                          : r.hasSurveyMap === false
                          ? 'no'
                          : null
                      }
                      onChange={(v) =>
                        patchRow(idx, {
                          hasSurveyMap: v === 'yes' ? true : v === 'no' ? false : null,
                        })
                      }
                      options={[
                        { value: 'yes', label: '有' },
                        { value: 'no', label: '無' },
                      ]}
                      allowNull={false}
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
