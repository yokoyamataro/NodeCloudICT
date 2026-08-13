// 土地調査報告書 の 一覧ページ (現在の工区スコープ)
//
// 動線:
//   工区未選択 → 案内表示
//   工区選択済み → その工区の 報告書一覧 + 新規作成 / 編集 / 削除 / Excel 出力
//
// 各行の 編集 ボタンで LandReportEditModal を開く。

import { useEffect, useState } from 'react'
import { FileText, Plus, Pencil, Trash2, Download, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useLandReportStore } from '@/stores/landReportStore'
import { LandReportEditModal } from './LandReportEditModal'

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

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`「${title}」 を削除しますか?\nこの操作は取り消せません。`)) return
    await deleteReport(id)
  }

  const handleExport = (_id: string) => {
    // TODO: 次フェーズで Excel 出力を実装
    alert('Excel 出力は 次フェーズで実装予定です。')
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="土地調査報告書作成"
        icon={<FileText className="h-5 w-5" />}
        actions={
          farmId && (
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              新規作成
            </button>
          )
        }
      />

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
                <th className="px-3 py-2 text-left border">タイトル</th>
                <th className="px-3 py-2 text-left border w-44">最終更新</th>
                <th className="px-3 py-2 text-left border w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 border">{r.title}</td>
                  <td className="px-3 py-2 border text-slate-600">
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
                        onClick={() => handleExport(r.id)}
                        className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded"
                        title="Excel 出力"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(r.id, r.title)}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                        title="削除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
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
