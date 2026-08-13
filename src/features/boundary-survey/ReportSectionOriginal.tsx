// 06 原本確認結果
//   * 自由記述 (textarea) + 組織の定型文から挿入。

import type { LandReportBody } from '@/stores/landReportStore'
import { SnippetPickerButton } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionOriginal({ body, onChange }: Props) {
  const insert = (text: string) => {
    const cur = body.originalCheck
    onChange({ originalCheck: cur ? `${cur}\n${text}` : text })
  }

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-end">
        <SnippetPickerButton category="original_check" onInsert={insert} />
      </div>
      <textarea
        value={body.originalCheck}
        onChange={(e) => onChange({ originalCheck: e.target.value })}
        rows={4}
        className="w-full px-2 py-1 text-xs border rounded"
        placeholder="原本を確認した結果、記載事項に相違ないことを確認した。 等"
      />
    </div>
  )
}
