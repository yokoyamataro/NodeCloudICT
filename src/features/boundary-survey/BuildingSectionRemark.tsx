// 08 補足・特記事項。 自由文 1 本。

import type { BuildingReportBody } from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

export function BuildingSectionRemark({ body, onChange }: Props) {
  return (
    <div className="p-3">
      <textarea
        value={body.remark}
        onChange={(e) => onChange({ remark: e.target.value })}
        rows={5}
        className="w-full px-2 py-1.5 text-sm border rounded"
      />
    </div>
  )
}
