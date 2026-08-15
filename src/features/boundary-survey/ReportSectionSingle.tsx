// 09 一筆地測量 (下半)
//   * 使用機器 + 観測期間

import type { LandReportBody } from '@/stores/landReportStore'
import { Field, RadioGroup } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionSingle({ body, onChange }: Props) {
  const s = body.singleParcelSurvey

  const patchDevices = (p: Partial<LandReportBody['singleParcelSurvey']['devices']>) => {
    onChange({ singleParcelSurvey: { ...s, devices: { ...s.devices, ...p } } })
  }
  const patch = (p: Partial<LandReportBody['singleParcelSurvey']>) => {
    onChange({ singleParcelSurvey: { ...s, ...p } })
  }

  return (
    <div className="p-3 space-y-3">
      <div className="border rounded p-2">
        <div className="text-xs font-semibold text-slate-700 mb-1">使用機器</div>
        <div className="flex items-center gap-3 flex-wrap">
          <RadioGroup
            name="single-devices"
            value={s.devices.ts ? 'ts' : s.devices.gnss ? 'gnss' : s.devices.other ? 'other' : null}
            onChange={(v) => patchDevices({
              ts: v === 'ts',
              gnss: v === 'gnss',
              other: v === 'other',
            })}
            options={[
              { value: 'ts', label: 'トータルステーション (TS)' },
              { value: 'gnss', label: 'GNSS' },
              { value: 'other', label: 'その他' },
            ]}
          />
          {s.devices.other && (
            <input
              type="text"
              value={s.devices.otherText}
              onChange={(e) => patchDevices({ otherText: e.target.value })}
              placeholder="機器名"
              className="px-2 py-1 text-xs border rounded flex-1 min-w-32"
            />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="観測開始">
          <input
            type="date"
            value={s.observationStart}
            onChange={(e) => patch({ observationStart: e.target.value })}
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </Field>
        <Field label="観測終了">
          <input
            type="date"
            value={s.observationEnd}
            onChange={(e) => patch({ observationEnd: e.target.value })}
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </Field>
      </div>
    </div>
  )
}
