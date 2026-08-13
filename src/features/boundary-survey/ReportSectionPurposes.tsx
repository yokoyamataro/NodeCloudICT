// 01 登記の目的
//   * 申請 1..n (可変行)
//   * 各行: 変更/更正 のラジオ + 事由チェックボックス群 + その他自由文

import { Plus, Trash2 } from 'lucide-react'
import type { LandReportBody, ReportPurposeRow } from '@/stores/landReportStore'
import { CheckboxLabel, RadioGroup } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyRow = (appNo: number): ReportPurposeRow => ({
  appNo,
  changeType: null,
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

  const patchRow = (idx: number, patch: Partial<ReportPurposeRow>) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
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
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-700">
                申請 {idx + 1}
              </span>
              <RadioGroup
                name={`purpose-changeType-${idx}`}
                value={r.changeType}
                onChange={(v) => patchRow(idx, { changeType: v })}
                options={[
                  { value: 'change', label: '変更' },
                  { value: 'correction', label: '更正' },
                ]}
              />
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="p-1 text-red-500 hover:bg-red-50 rounded"
                  title="この申請を削除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

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
                className="w-full px-2 py-1 text-xs border rounded"
              />
            )}
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
