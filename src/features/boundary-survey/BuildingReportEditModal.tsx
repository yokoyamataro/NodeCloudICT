// 建物調査報告書 の 編集 モーダル (骨組み)。 土地 の 雛形 に 準じる。
//
// 保存 動作:
//   title / body を 編集 すると dirty フラグ。
//   「保存」で updateReport、 「閉じる」で 未保存 時 確認。

import { useEffect, useMemo, useState } from 'react'
import { X, Save, Loader2 } from 'lucide-react'
import {
  useBuildingReportStore,
  DEFAULT_BUILDING_REPORT_BODY,
  type BuildingReport,
  type BuildingReportBody,
} from '@/stores/buildingReportStore'
import { BuildingSectionHeader } from './BuildingSectionHeader'
import { BuildingSectionPurposes } from './BuildingSectionPurposes'
import { BuildingSectionTargets } from './BuildingSectionTargets'
import { BuildingSectionOwners } from './BuildingSectionOwners'
import { BuildingSectionCauses } from './BuildingSectionCauses'
import { BuildingSectionMaterials } from './BuildingSectionMaterials'
import { BuildingSectionAnalyses } from './BuildingSectionAnalyses'
import { BuildingSectionSite } from './BuildingSectionSite'
import { BuildingSectionRemark } from './BuildingSectionRemark'

interface Props {
  reportId: string
  onClose: () => void
}

const SECTIONS: { id: string; title: string }[] = [
  { id: 'header',    title: 'ヘッダ (作成日・番号・調査士)' },
  { id: 'purpose',   title: '01 登記の目的' },
  { id: 'targets',   title: '02 調査した建物' },
  { id: 'owners',    title: '03 所有権登記名義人等' },
  { id: 'causes',    title: '04 登記原因及びその日付' },
  { id: 'materials', title: '05 調査資料・証言・事実等' },
  { id: 'analyses',  title: '06 資料・証言・事実等の分析' },
  { id: 'site',      title: '07 現地の状況 (写真)' },
  { id: 'remark',    title: '08 補足・特記事項' },
]

function renderSection(
  id: string,
  body: BuildingReportBody,
  patch: (p: Partial<BuildingReportBody>) => void,
) {
  switch (id) {
    case 'header':    return <BuildingSectionHeader body={body} onChange={patch} />
    case 'purpose':   return <BuildingSectionPurposes body={body} onChange={patch} />
    case 'targets':   return <BuildingSectionTargets body={body} onChange={patch} />
    case 'owners':    return <BuildingSectionOwners body={body} onChange={patch} />
    case 'causes':    return <BuildingSectionCauses body={body} onChange={patch} />
    case 'materials': return <BuildingSectionMaterials body={body} onChange={patch} />
    case 'analyses':  return <BuildingSectionAnalyses body={body} onChange={patch} />
    case 'site':      return <BuildingSectionSite body={body} onChange={patch} />
    case 'remark':    return <BuildingSectionRemark body={body} onChange={patch} />
    default:          return null
  }
}

export function BuildingReportEditModal({ reportId, onClose }: Props) {
  const byFarm = useBuildingReportStore((s) => s.byFarm)
  const updateReport = useBuildingReportStore((s) => s.updateReport)

  const report: BuildingReport | null = useMemo(() => {
    for (const list of byFarm.values()) {
      const r = list.find((x) => x.id === reportId)
      if (r) return r
    }
    return null
  }, [byFarm, reportId])

  const [title, setTitle] = useState(report?.title ?? '')
  const [body, setBody] = useState<BuildingReportBody>(
    report?.body ?? DEFAULT_BUILDING_REPORT_BODY,
  )
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (report) {
      setTitle(report.title)
      setBody(report.body)
      setDirty(false)
    }
  }, [report])

  if (!report) return null

  const handleTitleChange = (v: string) => {
    setTitle(v)
    setDirty(true)
  }

  const patchBody = (patch: Partial<BuildingReportBody>) => {
    setBody((prev) => ({ ...prev, ...patch }))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    await updateReport(reportId, { title, body })
    setSaving(false)
    setDirty(false)
  }

  const handleClose = () => {
    if (dirty) {
      if (!confirm('未保存の変更があります。閉じてよろしいですか?')) return
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl h-[90vh] flex flex-col">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="flex-1 text-lg font-semibold px-2 py-1 border rounded"
            placeholder="報告書タイトル"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 hover:bg-slate-100 rounded"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          {SECTIONS.map((s) => (
            <section key={s.id} id={`section-${s.id}`} className="border rounded">
              <header className="px-3 py-2 bg-slate-50 border-b">
                <h2 className="text-sm font-semibold text-slate-800">{s.title}</h2>
              </header>
              {renderSection(s.id, body, patchBody)}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
