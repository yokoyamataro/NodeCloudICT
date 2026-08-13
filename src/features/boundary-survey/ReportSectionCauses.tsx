// 04 登記原因及びその日付
//   * 申請 1..n (可変行)
//   * 各行: 地番 / 原因日付 / 原因 / 事由

import { Plus, Trash2 } from 'lucide-react'
import type { LandReportBody, ReportCauseRow } from '@/stores/landReportStore'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyRow = (appNo: number): ReportCauseRow => ({
  appNo,
  parcelNumber: '',
  causeDate: '',
  cause: '',
  reason: '',
})

export function ReportSectionCauses({ body, onChange }: Props) {
  const rows = body.causes

  const setRows = (next: ReportCauseRow[]) => {
    onChange({ causes: next.map((r, i) => ({ ...r, appNo: i + 1 })) })
  }
  const patchRow = (idx: number, patch: Partial<ReportCauseRow>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))

  return (
    <div className="p-3 space-y-2">
      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">
          登記原因の行がありません。「行を追加」から入力してください。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-1 py-1 border w-8">#</th>
                <th className="px-1 py-1 border text-left w-24">地番</th>
                <th className="px-1 py-1 border text-left w-32">原因日付</th>
                <th className="px-1 py-1 border text-left">原因</th>
                <th className="px-1 py-1 border text-left">事由</th>
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
                      value={r.parcelNumber}
                      onChange={(e) => patchRow(idx, { parcelNumber: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="date"
                      value={r.causeDate}
                      onChange={(e) => patchRow(idx, { causeDate: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.cause}
                      onChange={(e) => patchRow(idx, { cause: e.target.value })}
                      placeholder="例: 錯誤"
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.reason}
                      onChange={(e) => patchRow(idx, { reason: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
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
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3 w-3" /> 行を追加
      </button>
    </div>
  )
}
