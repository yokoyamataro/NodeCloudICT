// 土地調査報告書 の 一覧ページ (現在の工区スコープ)
//
// 動線:
//   工区未選択 → 案内表示
//   工区選択済み → その工区の 報告書一覧 + 新規作成 / 編集 / 削除 / Excel 出力
//
// 各行の 編集 ボタンで LandReportEditModal を開く。
// 一覧列: 報告書番号 / 作成日 / 登記の目的 / 調査した土地 / 最終更新 / 操作

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Download, Loader2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  useLandReportStore,
  type LandReport,
  type ReportPurposeRow,
} from '@/stores/landReportStore'
import { LandReportEditModal } from './LandReportEditModal'
import { exportLandReportToExcel, downloadBlob } from '@/lib/landReportExport'

const EVENT_LABELS: Record<keyof ReportPurposeRow['events'], string> = {
  title: '表題',
  subdivision: '分筆',
  merger: '合筆',
  location: '所在',
  landCategory: '地目',
  area: '地積',
  mapCorrection: '地図訂正',
  surveyMapCorrection: '地積測量図訂正',
  locationMapCorrection: '土地所在図訂正',
  other: 'その他',
  otherText: '',
}

/** 登記の目的 (チェック済み事由 + 変更/更正) を 「・」区切りで整形 */
function formatPurposes(purposes: ReportPurposeRow[]): string {
  const lines: string[] = []
  for (const p of purposes) {
    const items: string[] = []
    for (const [key, label] of Object.entries(EVENT_LABELS) as Array<
      [keyof ReportPurposeRow['events'], string]
    >) {
      if (key === 'otherText') continue
      if (p.events[key]) items.push(label)
    }
    if (p.changeType?.change) items.push('変更')
    if (p.changeType?.correction) items.push('更正')
    if (items.length > 0) lines.push(items.join('・'))
  }
  return lines.join(' / ')
}

/** 調査した土地: 先頭の 所在+地番 + 他 N 筆 (残りがあれば) */
function formatParcels(parcels: LandReport['body']['parcels']): string {
  if (parcels.length === 0) return ''
  const first = parcels[0]
  const head = `${first.location}${first.parcelNumber}`.trim() || '-'
  if (parcels.length === 1) return head
  return `${head}他${parcels.length - 1}筆`
}

/** 作成日 (meta.reportDate) を "YYYY年M月D日" に整形 */
function formatReportDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function LandReportPage() {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const byFarm = useLandReportStore((s) => s.byFarm)
  const loading = useLandReportStore((s) => s.loading)
  const error = useLandReportStore((s) => s.error)
  const fetchByFarm = useLandReportStore((s) => s.fetchByFarm)
  const createReport = useLandReportStore((s) => s.createReport)
  const deleteReport = useLandReportStore((s) => s.deleteReport)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const farmId = currentFarm?.id ?? null
  const reports = farmId ? byFarm.get(farmId) ?? [] : []

  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  const handleCreate = async () => {
    if (!farmId) return
    setCreating(true)
    const r = await createReport(farmId)
    setCreating(false)
    if (r) setEditingId(r.id)
  }

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`「${label}」 を削除しますか?\nこの操作は取り消せません。`)) return
    await deleteReport(id)
  }

  const handleExport = async (id: string) => {
    if (!farmId) return
    const report = (byFarm.get(farmId) ?? []).find((r) => r.id === id)
    if (!report) return
    try {
      const blob = await exportLandReportToExcel(report)
      // ファイル名: 報告書番号があれば それ、なければ タイトル or 'report'
      const base = report.body.meta.reportNo?.trim() || report.title || 'report'
      const safe = base.replace(/[\\/:*?"<>|]/g, '_')
      downloadBlob(blob, `${safe}.xlsx`)
    } catch (e) {
      alert(`Excel 出力に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* 旧ヘッダ (現場名 / 工区名 / メニュー名 / 説明) は 廃止。操作だけ 残す */}
      {farmId && (
        <div className="px-4 py-2 border-b bg-white flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            新規作成
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!farmId ? (
          <div className="text-sm text-slate-500">
            工区を選択してください。左メニューの プロジェクト/工区 から 対象の工区を選ぶと、その工区の 土地調査報告書 一覧が表示されます。
          </div>
        ) : error ? (
          <div className="px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200 rounded">
            {error}
          </div>
        ) : loading && reports.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
          </div>
        ) : reports.length === 0 ? (
          <div className="text-sm text-slate-500">
            この工区には まだ 土地調査報告書がありません。「新規作成」から 追加してください。
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2 text-left border w-28">報告書番号</th>
                <th className="px-3 py-2 text-left border w-32">作成日</th>
                <th className="px-3 py-2 text-left border">登記の目的</th>
                <th className="px-3 py-2 text-left border">調査した土地</th>
                <th className="px-3 py-2 text-left border w-40">最終更新</th>
                <th className="px-3 py-2 text-left border w-32">操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const reportNo = r.body.meta.reportNo?.trim() || '—'
                const reportDate = formatReportDate(r.body.meta.reportDate)
                const purposesText = formatPurposes(r.body.purposes)
                const parcelsText = formatParcels(r.body.parcels)
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 border font-medium text-slate-800">
                      {reportNo}
                    </td>
                    <td className="px-3 py-2 border text-slate-700">
                      {reportDate || '—'}
                    </td>
                    <td className="px-3 py-2 border text-slate-700">
                      {purposesText || '—'}
                    </td>
                    <td className="px-3 py-2 border text-slate-700">
                      {parcelsText || '—'}
                    </td>
                    <td className="px-3 py-2 border text-slate-600 text-xs">
                      {new Date(r.updatedAt).toLocaleString('ja-JP')}
                    </td>
                    <td className="px-3 py-2 border">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingId(r.id)}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                          title="編集"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleExport(r.id)}
                          className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded"
                          title="Excel 出力"
                        >
                          <Download className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(r.id, reportNo)}
                          className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                          title="削除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {editingId && (
        <LandReportEditModal
          reportId={editingId}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
