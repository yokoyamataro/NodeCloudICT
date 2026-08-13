// 08 地域区分・精度区分

import type { LandReportBody } from '@/stores/landReportStore'
import { Field, RadioGroup } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionRegion({ body, onChange }: Props) {
  const ra = body.regionAccuracy

  return (
    <div className="p-3 grid grid-cols-2 gap-3">
      <Field label="地域区分">
        <RadioGroup
          name="region"
          value={ra.region}
          onChange={(v) => onChange({ regionAccuracy: { ...ra, region: v } })}
          options={[
            { value: 'urban', label: '市街地地域' },
            { value: 'village', label: '村落・農耕地域' },
            { value: 'mountain', label: '山林・原野地域' },
          ]}
        />
      </Field>
      <Field label="精度区分">
        <RadioGroup
          name="accuracy"
          value={ra.accuracy}
          onChange={(v) => onChange({ regionAccuracy: { ...ra, accuracy: v } })}
          options={[
            { value: 'a1', label: '甲一' },
            { value: 'a2', label: '甲二' },
            { value: 'a3', label: '甲三' },
            { value: 'b1', label: '乙一' },
            { value: 'b2', label: '乙二' },
            { value: 'b3', label: '乙三' },
          ]}
        />
      </Field>
    </div>
  )
}
