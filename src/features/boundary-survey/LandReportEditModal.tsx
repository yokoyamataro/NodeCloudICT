// 土地調査報告書 の 編集モーダル (骨組みのみ)。
//
// 各セクション (01 登記の目的 〜 10 補足) は 順次 実装していく。
// 現時点では タイトル編集 + 各セクションのプレースホルダのみを表示する。
//
// 保存動作:
//   タイトル / body を 変更したら dirty フラグを立てる。
//   「保存」ボタンで useLandReportStore.updateReport を呼ぶ。
//   「閉じる」で dirty のときは 確認ダイアログ。

import { useEffect, useMemo, useState } from 'react'
import { X, Save, Loader2 } from 'lucide-react'
import {
  useLandReportStore,
  DEFAULT_LAND_REPORT_BODY,
  type LandReport,
  type LandReportBody,
} from '@/stores/landReportStore'
import { ReportSectionHeader } from './ReportSectionHeader'
import { ReportSectionPurposes } from './ReportSectionPurposes'
import { ReportSectionParcels } from './ReportSectionParcels'
import { ReportSectionOwners } from './ReportSectionOwners'
import { ReportSectionCauses } from './ReportSectionCauses'
import { ReportSectionMaterials } from './ReportSectionMaterials'
import { ReportSectionOriginal } from './ReportSectionOriginal'
import { ReportSectionSite } from './ReportSectionSite'
import { ReportSectionRegion } from './ReportSectionRegion'
import { ReportSectionBoundary } from './ReportSectionBoundary'
import { ReportSectionSingle } from './ReportSectionSingle'
import { ReportSectionKoosa } from './ReportSectionKoosa'
import { ReportSectionRemark } from './ReportSectionRemark'

interface Props {
  reportId: string
  onClose: () => void
}

/** セクション一覧 */
const SECTIONS: { id: string; title: string }[] = [
  { id: 'header',    title: 'ヘッダ (作成日・番号・調査士)' },
  { id: 'purpose',   title: '01 登記の目的' },
  { id: 'parcels',   title: '02 調査した土地' },
  { id: 'owners',    title: '03 所有権登記名義人 (立会人)' },
  { id: 'causes',    title: '04 登記原因及びその日付' },
  { id: 'materials', title: '05 資料調査' },
  { id: 'original',  title: '06 原本確認結果' },
  { id: 'site',      title: '07 現地確認 (写真)' },
  { id: 'region',    title: '08 地域区分・精度区分' },
  { id: 'boundary',  title: '09 筆界位置の計測' },
  { id: 'single',    title: '09 一筆地測量' },
  { id: 'koosa',     title: '09 甲差検証 (自動計算)' },
  { id: 'remark',    title: '10 補足・特記事項' },
]

function renderSection(
  id: string,
  body: LandReportBody,
  patch: (p: Partial<LandReportBody>) => void,
) {
  switch (id) {
    case 'header':    return <ReportSectionHeader body={body} onChange={patch} />
    case 'purpose':   return <ReportSectionPurposes body={body} onChange={patch} />
    case 'parcels':   return <ReportSectionParcels body={body} onChange={patch} />
    case 'owners':    return <ReportSectionOwners body={body} onChange={patch} />
    case 'causes':    return <ReportSectionCauses body={body} onChange={patch} />
    case 'materials': return <ReportSectionMaterials body={body} onChange={patch} />
    case 'original':  return <ReportSectionOriginal body={body} onChange={patch} />
    case 'site':      return <ReportSectionSite body={body} onChange={patch} />
    case 'region':    return <ReportSectionRegion body={body} onChange={patch} />
    case 'boundary':  return <ReportSectionBoundary body={body} onChange={patch} />
    case 'single':    return <ReportSectionSingle body={body} onChange={patch} />
    case 'koosa':     return <ReportSectionKoosa body={body} onChange={patch} />
    case 'remark':    return <ReportSectionRemark body={body} onChange={patch} />
    default:          return null
  }
}

export function LandReportEditModal({ reportId, onClose }: Props) {
  const byFarm = useLandReportStore((s) => s.byFarm)
  const updateReport = useLandReportStore((s) => s.updateReport)

  // 現在の report を byFarm から拾う
  const report: LandReport | null = useMemo(() => {
    for (const list of byFarm.values()) {
      const r = list.find((x) => x.id === reportId)
      if (r) return r
    }
    return null
  }, [byFarm, reportId])

  const [title, setTitle] = useState(report?.title ?? '')
  const [body, setBody] = useState<LandReportBody>(
    report?.body ?? DEFAULT_LAND_REPORT_BODY,
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

  const patchBody = (patch: Partial<LandReportBody>) => {
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
        {/* ヘッダ */}
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

        {/* 本体 (セクション一覧) */}
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          {SECTIONS.map((s) => (
            <section
              key={s.id}
              id={`section-${s.id}`}
              className="border rounded"
            >
              <header className="px-3 py-2 bg-slate-50 border-b flex items-center justify-between">
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
