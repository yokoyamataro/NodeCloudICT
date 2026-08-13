// 10 補足・特記事項
//   * 自由記述 (textarea) + 組織の定型文から挿入。

import type { LandReportBody } from '@/stores/landReportStore'
import { SnippetPickerButton } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionRemark({ body, onChange }: Props) {
  const insert = (text: string) => {
    const cur = body.remark
    onChange({ remark: cur ? `${cur}\n${text}` : text })
  }

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-end">
        <SnippetPickerButton category="remark" onInsert={insert} />
      </div>
      <textarea
        value={body.remark}
        onChange={(e) => onChange({ remark: e.target.value })}
        rows={4}
        className="w-full px-2 py-1 text-xs border rounded"
        placeholder="申請時に添付する補足事項があれば記入"
      />
    </div>
  )
}
