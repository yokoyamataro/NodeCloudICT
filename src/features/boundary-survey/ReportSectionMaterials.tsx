// 05 資料調査
//   * 事前調査で使用した資料の チェックボックス群 + 補足文
//   * body.materials は Record<string, boolean | string> (自由キー) だが
//     ここでは 想定される固定キーだけを扱う。

import type { LandReportBody } from '@/stores/landReportStore'
import { CheckboxLabel } from './reportSectionUi'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const MATERIALS: { key: string; label: string }[] = [
  { key: 'registered_deed', label: '登記事項証明書' },
  { key: 'map', label: '地図 (14 条 1 項)' },
  { key: 'map_alternative', label: '地図に準ずる図面 (公図)' },
  { key: 'survey_map', label: '地積測量図' },
  { key: 'location_map', label: '土地所在図' },
  { key: 'building_map', label: '建物図面・各階平面図' },
  { key: 'old_koozu', label: '旧公図' },
  { key: 'aza_map', label: '字図' },
  { key: 'boundary_confirm', label: '境界確認書' },
  { key: 'past_survey', label: '過去の測量成果' },
  { key: 'city_planning', label: '都市計画図' },
  { key: 'aerial_photo', label: '空中写真' },
]

const NOTES_KEY = '_notes'

export function ReportSectionMaterials({ body, onChange }: Props) {
  const materials = body.materials

  const setChecked = (key: string, v: boolean) => {
    onChange({ materials: { ...materials, [key]: v } })
  }
  const setNotes = (v: string) => {
    onChange({ materials: { ...materials, [NOTES_KEY]: v } })
  }

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
        {MATERIALS.map((m) => (
          <CheckboxLabel
            key={m.key}
            checked={materials[m.key] === true}
            onChange={(v) => setChecked(m.key, v)}
          >
            {m.label}
          </CheckboxLabel>
        ))}
      </div>
      <div>
        <div className="text-[11px] text-slate-500 mb-0.5">その他・補足</div>
        <textarea
          value={typeof materials[NOTES_KEY] === 'string' ? (materials[NOTES_KEY] as string) : ''}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full px-2 py-1 text-xs border rounded"
          placeholder="上記以外に参照した資料があれば記入"
        />
      </div>
    </div>
  )
}
