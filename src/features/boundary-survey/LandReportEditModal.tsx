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

interface Props {
  reportId: string
  onClose: () => void
}

/** セクション一覧 (実装済みかは 順次 差し替え) */
const SECTIONS: { id: string; title: string; note: string }[] = [
  { id: 'header',    title: 'ヘッダ (作成日・番号・調査士)', note: '' },
  { id: 'purpose',   title: '01 登記の目的',                  note: '未実装' },
  { id: 'parcels',   title: '02 調査した土地',                note: '未実装' },
  { id: 'owners',    title: '03 所有権登記名義人 (立会人)',   note: '未実装' },
  { id: 'causes',    title: '04 登記原因及びその日付',        note: '未実装' },
  { id: 'materials', title: '05 資料調査',                    note: '未実装' },
  { id: 'original',  title: '06 原本確認結果',                note: '未実装' },
  { id: 'site',      title: '07 現地確認 (写真)',             note: '未実装' },
  { id: 'region',    title: '08 地域区分・精度区分',          note: '未実装' },
  { id: 'boundary',  title: '09 筆界位置の計測',              note: '未実装' },
  { id: 'single',    title: '09 一筆地測量',                  note: '未実装' },
  { id: 'remark',    title: '10 補足・特記事項',              note: '未実装' },
]

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
                {s.note && <span className="text-xs text-slate-400">{s.note}</span>}
              </header>
              {s.id === 'header' ? (
                <ReportSectionHeader body={body} onChange={patchBody} />
              ) : (
                <div className="p-3 text-xs text-slate-400">
                  このセクションの 入力 UI は 順次 追加されます。
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
