// 01 登記の目的
//   * 申請 1..n (可変行)
//   * 各行: 左に 事由チェックボックス群 (表題/分筆/...) + 右に 変更/更正 (複数可)

import { Plus, Trash2 } from 'lucide-react'
import type { LandReportBody, ReportPurposeRow } from '@/stores/landReportStore'
import { CheckboxLabel } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyRow = (appNo: number): ReportPurposeRow => ({
  appNo,
  changeType: { change: false, correction: false },
  events: {
    title: false,
    subdivision: false,
    merger: false,
    location: false,
    landCategory: false,
    area: false,
    mapCorrection: false,
    surveyMapCorrection: false,
    locationMapCorrection: false,
    other: false,
    otherText: '',
  },
})

export function ReportSectionPurposes({ body, onChange }: Props) {
  const rows = body.purposes

  const setRows = (next: ReportPurposeRow[]) => {
    onChange({ purposes: next.map((r, i) => ({ ...r, appNo: i + 1 })) })
  }

  const patchChangeType = (idx: number, patch: Partial<ReportPurposeRow['changeType']>) => {
    setRows(
      rows.map((r, i) =>
        i === idx ? { ...r, changeType: { ...r.changeType, ...patch } } : r,
      ),
    )
  }

  const patchEvents = (idx: number, patch: Partial<ReportPurposeRow['events']>) => {
    setRows(
      rows.map((r, i) =>
        i === idx ? { ...r, events: { ...r.events, ...patch } } : r,
      ),
    )
  }

  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))

  return (
    <div className="p-3 space-y-3">
      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">
          申請行がありません。「申請を追加」で 1 件目を作成してください。
        </div>
      ) : (
        rows.map((r, idx) => (
          <div key={idx} className="border rounded p-2 space-y-2 bg-white">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-700">
                申請 {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                className="ml-auto p-1 text-red-500 hover:bg-red-50 rounded"
                title="この申請を削除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 事件名 (左) + 変更/更正 (右) を 縦線で区切って横並び */}
            <div className="flex items-start gap-3">
              {/* 左: 事由チェックボックス */}
              <div className="flex-1 min-w-0">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                  <CheckboxLabel
                    checked={r.events.title}
                    onChange={(v) => patchEvents(idx, { title: v })}
                  >
                    表題
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.subdivision}
                    onChange={(v) => patchEvents(idx, { subdivision: v })}
                  >
                    分筆
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.merger}
                    onChange={(v) => patchEvents(idx, { merger: v })}
                  >
                    合筆
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.location}
                    onChange={(v) => patchEvents(idx, { location: v })}
                  >
                    所在
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.landCategory}
                    onChange={(v) => patchEvents(idx, { landCategory: v })}
                  >
                    地目
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.area}
                    onChange={(v) => patchEvents(idx, { area: v })}
                  >
                    地積
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.mapCorrection}
                    onChange={(v) => patchEvents(idx, { mapCorrection: v })}
                  >
                    地図訂正
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.surveyMapCorrection}
                    onChange={(v) => patchEvents(idx, { surveyMapCorrection: v })}
                  >
                    地積測量図訂正
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.locationMapCorrection}
                    onChange={(v) => patchEvents(idx, { locationMapCorrection: v })}
                  >
                    土地所在図訂正
                  </CheckboxLabel>
                  <CheckboxLabel
                    checked={r.events.other}
                    onChange={(v) => patchEvents(idx, { other: v })}
                  >
                    その他
                  </CheckboxLabel>
                </div>
                {r.events.other && (
                  <input
                    type="text"
                    value={r.events.otherText}
                    onChange={(e) => patchEvents(idx, { otherText: e.target.value })}
                    placeholder="その他の内容"
                    className="mt-1 w-full px-2 py-1 text-xs border rounded"
                  />
                )}
              </div>
              {/* 右: 変更/更正 (複数選択可) — 縦線で区切る */}
              <div className="border-l pl-3 flex flex-col gap-1 min-w-20">
                <CheckboxLabel
                  checked={r.changeType.change}
                  onChange={(v) => patchChangeType(idx, { change: v })}
                >
                  変更
                </CheckboxLabel>
                <CheckboxLabel
                  checked={r.changeType.correction}
                  onChange={(v) => patchChangeType(idx, { correction: v })}
                >
                  更正
                </CheckboxLabel>
              </div>
            </div>
          </div>
        ))
      )}

      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3 w-3" /> 申請を追加
      </button>
    </div>
  )
}
