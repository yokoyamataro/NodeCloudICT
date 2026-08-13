// 07 現地確認
//   * 現状写真を添付したかの チェックのみ (写真本体は Excel 側で貼付)

import type { LandReportBody } from '@/stores/landReportStore'
import { CheckboxLabel } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionSite({ body, onChange }: Props) {
  return (
    <div className="p-3">
      <CheckboxLabel
        checked={body.siteStatus.attached}
        onChange={(v) => onChange({ siteStatus: { attached: v } })}
      >
        現地の状況を確認する写真を 別紙に添付した
      </CheckboxLabel>
    </div>
  )
}
