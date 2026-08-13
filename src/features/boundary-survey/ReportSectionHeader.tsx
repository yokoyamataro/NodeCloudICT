// 土地調査報告書 - ヘッダ セクション。
//   * meta.reportDate
//   * meta.reportNo
//   * meta.surveyorId  (organization_surveyors から選択)
//
// 調査士を選ぶと、登録番号 / 所属会 / 電話番号 は 調査士セットから
// 自動で決まる (Excel 出力時に surveyor 全項目を差し込む方式なので、
// ここでは surveyorId のみを保持する)。

import { Loader2 } from 'lucide-react'
import type { LandReportBody } from '@/stores/landReportStore'
import { useOrganizationSurveyors } from './useOrganizationSurveyors'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionHeader({ body, onChange }: Props) {
  const { surveyors, organizationId, loading, error } = useOrganizationSurveyors()

  const patchMeta = (patch: Partial<LandReportBody['meta']>) => {
    onChange({ meta: { ...body.meta, ...patch } })
  }

  const selected = surveyors.find((s) => s.id === body.meta.surveyorId) ?? null

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-slate-600 mb-1">作成日</span>
          <input
            type="date"
            value={body.meta.reportDate}
            onChange={(e) => patchMeta({ reportDate: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border rounded"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-slate-600 mb-1">報告書番号</span>
          <input
            type="text"
            value={body.meta.reportNo}
            onChange={(e) => patchMeta({ reportNo: e.target.value })}
            placeholder="例: 2026-001"
            className="w-full px-2 py-1.5 text-sm border rounded"
          />
        </label>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-slate-600">土地家屋調査士</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
        </div>
        {error ? (
          <div className="px-2 py-1 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
            {error}
          </div>
        ) : !organizationId ? (
          <div className="px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded">
            所属組織が特定できません。組織に所属してから 使用してください。
          </div>
        ) : surveyors.length === 0 && !loading ? (
          <div className="px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded">
            この組織に 土地家屋調査士が 登録されていません。
            管理画面 「組織管理 &gt; 土地家屋調査士」 から 登録してください。
          </div>
        ) : (
          <select
            value={body.meta.surveyorId ?? ''}
            onChange={(e) =>
              patchMeta({ surveyorId: e.target.value || null })
            }
            className="w-full px-2 py-1.5 text-sm border rounded bg-white"
          >
            <option value="">— 選択してください —</option>
            {surveyors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.registrationNo ? ` (登録番号: ${s.registrationNo})` : ''}
              </option>
            ))}
          </select>
        )}
        {selected && (
          <div className="mt-2 text-xs text-slate-600 bg-slate-50 border rounded px-2 py-1.5 space-y-0.5">
            <div>
              <span className="text-slate-500">所属会:</span>{' '}
              {selected.officeName || '—'}
            </div>
            <div>
              <span className="text-slate-500">登録番号:</span>{' '}
              {selected.registrationNo || '—'}
            </div>
            <div>
              <span className="text-slate-500">電話番号:</span>{' '}
              {selected.phoneNo || '—'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
