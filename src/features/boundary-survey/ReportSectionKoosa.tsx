// 09 甲差検証欄
//   * 02 の parcels とは独立に、地番を都度選択して 検証行を作る。
//   * 各行: 登記面積 と 実測面積 を入力 (取り込み時は自動、手動でも編集可)
//   * 公差 = (a + b·F^¼)·F^½ (F = 実測面積, a/b は 08 精度区分ごとの係数)
//   * 判定: |差| ≤ 公差 なら 「適」、そうでなければ 「不適」

import { useMemo, useState } from 'react'
import { Plus, Trash2, ListChecks } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import type { LandReportBody, ReportKoosaRow } from '@/stores/landReportStore'
import {
  evaluateKoosa,
  ACCURACY_LABEL,
  type AccuracyClass,
} from '@/lib/landReportKoosa'
import { ParcelPickerModal, type PickableParcel } from './ParcelPickerModal'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyRow = (): ReportKoosaRow => ({
  parcelId: null,
  location: '',
  parcelNumber: '',
  registeredAreaSqm: null,
  measuredAreaSqm: null,
})

export function ReportSectionKoosa({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const accuracy = body.regionAccuracy.accuracy as AccuracyClass | null
  const [pickerOpen, setPickerOpen] = useState(false)

  const rows = body.koosaRows

  const alreadyIn = useMemo(
    () => new Set(rows.map((r) => r.parcelId).filter(Boolean) as string[]),
    [rows],
  )

  const setRows = (next: ReportKoosaRow[]) => onChange({ koosaRows: next })
  const patchRow = (idx: number, patch: Partial<ReportKoosaRow>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const handleImport = (picked: PickableParcel[]) => {
    const additions: ReportKoosaRow[] = picked.map((p) => ({
      parcelId: p.id,
      location: p.location,
      parcelNumber: p.parcelNumber,
      registeredAreaSqm: p.registeredAreaSqm,
      measuredAreaSqm: p.areaSqm,
    }))
    setRows([...rows, ...additions])
    setPickerOpen(false)
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={!currentFarm?.id}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          <ListChecks className="h-3 w-3" /> 地番から選択して取り込み
        </button>
        <button
          type="button"
          onClick={() => setRows([...rows, emptyRow()])}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        >
          <Plus className="h-3 w-3" /> 手動で追加
        </button>
        {accuracy && (
          <span className="ml-auto text-xs text-slate-600">
            精度区分: <strong>{ACCURACY_LABEL[accuracy]}</strong>
          </span>
        )}
      </div>

      {!accuracy && (
        <div className="px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded">
          08 で 精度区分を選択すると、公差と判定が自動計算されます。
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">
          検証する地番がありません。「地番から選択して取り込み」または「手動で追加」で行を作成してください。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-1 py-1 border w-8">#</th>
                <th className="px-1 py-1 border text-left">所在</th>
                <th className="px-1 py-1 border text-left w-24">地番</th>
                <th className="px-1 py-1 border text-right w-24">登記面積 (㎡)</th>
                <th className="px-1 py-1 border text-right w-24">実測面積 (㎡)</th>
                <th className="px-1 py-1 border text-right w-20">差 (㎡)</th>
                <th className="px-1 py-1 border text-right w-24">公差 (㎡)</th>
                <th className="px-1 py-1 border text-center w-16">判定</th>
                <th className="w-8 border"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const { diff, tolerance, verdict } = evaluateKoosa(
                  accuracy,
                  r.registeredAreaSqm,
                  r.measuredAreaSqm,
                )
                const verdictLabel =
                  verdict === 'ok' ? '適' : verdict === 'ng' ? '不適' : '—'
                const verdictClass =
                  verdict === 'ok'
                    ? 'text-emerald-700 bg-emerald-50'
                    : verdict === 'ng'
                    ? 'text-red-700 bg-red-50'
                    : 'text-slate-400'
                return (
                  <tr key={idx}>
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
                        type="number"
                        step="0.01"
                        value={r.registeredAreaSqm ?? ''}
                        onChange={(e) =>
                          patchRow(idx, {
                            registeredAreaSqm:
                              e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                        className="w-full px-1 py-0.5 border rounded text-right"
                      />
                    </td>
                    <td className="px-1 py-0.5 border">
                      <input
                        type="number"
                        step="0.01"
                        value={r.measuredAreaSqm ?? ''}
                        onChange={(e) =>
                          patchRow(idx, {
                            measuredAreaSqm:
                              e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                        className="w-full px-1 py-0.5 border rounded text-right"
                      />
                    </td>
                    <td className="px-1 py-0.5 border text-right">
                      {diff != null ? diff.toFixed(2) : '—'}
                    </td>
                    <td className="px-1 py-0.5 border text-right">
                      {tolerance != null ? tolerance.toFixed(2) : '—'}
                    </td>
                    <td
                      className={`px-1 py-0.5 border text-center font-semibold ${verdictClass}`}
                    >
                      {verdictLabel}
                    </td>
                    <td className="px-1 py-0.5 border text-center">
                      <button
                        type="button"
                        onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                        className="p-1 text-red-500 hover:bg-red-50 rounded"
                        title="削除"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pickerOpen && currentFarm?.id && (
        <ParcelPickerModal
          farmId={currentFarm.id}
          alreadyIn={alreadyIn}
          onCancel={() => setPickerOpen(false)}
          onConfirm={handleImport}
        />
      )}
    </div>
  )
}
