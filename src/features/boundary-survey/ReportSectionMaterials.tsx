// 05 資料調査
//   * 資料の チェックボックス群 (グループ分け) + 補足文
//   * 一覧は reportMaterials.ts に集約 (Excel 出力側と共有)

import type { LandReportBody } from '@/stores/landReportStore'
import { CheckboxLabel } from './reportSectionUi'
import {
  MATERIAL_GROUPS,
  MATERIALS_NOTES_KEY,
} from './reportMaterials'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionMaterials({ body, onChange }: Props) {
  const materials = body.materials

  const setBool = (key: string, v: boolean) => {
    onChange({ materials: { ...materials, [key]: v } })
  }
  const setText = (key: string, v: string) => {
    onChange({ materials: { ...materials, [key]: v } })
  }

  return (
    <div className="p-3 space-y-3">
      {MATERIAL_GROUPS.map((group) => (
        <div key={group.label} className="border rounded">
          <div className="px-2 py-1 bg-slate-50 border-b text-xs font-semibold text-slate-700">
            {group.label}
          </div>
          <div className="p-2 grid grid-cols-1 md:grid-cols-2 gap-y-1 gap-x-3">
            {group.items.map((item) => {
              const checked = materials[item.key] === true
              return (
                <div key={item.key} className="flex items-center gap-2">
                  <CheckboxLabel
                    checked={checked}
                    onChange={(v) => setBool(item.key, v)}
                  >
                    {item.label}
                  </CheckboxLabel>
                  {item.hasText && item.textKey && (
                    <input
                      type="text"
                      value={
                        typeof materials[item.textKey] === 'string'
                          ? (materials[item.textKey] as string)
                          : ''
                      }
                      onChange={(e) => setText(item.textKey!, e.target.value)}
                      placeholder={item.textPlaceholder}
                      disabled={!checked}
                      className="flex-1 min-w-24 px-2 py-0.5 text-xs border rounded disabled:bg-slate-50"
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div>
        <div className="text-[11px] text-slate-500 mb-0.5">補足 (自由記述)</div>
        <textarea
          value={
            typeof materials[MATERIALS_NOTES_KEY] === 'string'
              ? (materials[MATERIALS_NOTES_KEY] as string)
              : ''
          }
          onChange={(e) => setText(MATERIALS_NOTES_KEY, e.target.value)}
          rows={2}
          className="w-full px-2 py-1 text-xs border rounded"
          placeholder="上記以外の補足があれば記入"
        />
      </div>
    </div>
  )
}
