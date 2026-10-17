// 建物調査報告書 の 一覧ページ (現在 の 工区 スコープ)。
//
// 動線 は 土地調査報告書 (LandReportPage) と 同じ:
//   工区未選択 → 案内
//   工区選択済 → 一覧 + 新規 / 編集 / 削除 / (Excel 出力 は 後日)
//
// 列: 報告書番号 / 作成日 / 登記の目的 / 調査した建物 / 最終更新 / 操作

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  useBuildingReportStore,
  type BuildingReport,
  type BuildingPurposeRow,
} from '@/stores/buildingReportStore'
import { BuildingReportEditModal } from './BuildingReportEditModal'

const EVENT_LABELS: Record<keyof BuildingPurposeRow['events'], string> = {
  title: '表題',
  loss: '滅失',
  titleSection: '表題部',
  split: '分割',
  merge: '合併',
  combine: '合体',
  floorPlanCorrection: '建物図面訂正',
  eachFloorPlanCorrection: '各階平面図訂正',
  other: 'その他',
  otherText: '',
}

function formatPurposes(purposes: BuildingPurposeRow[]): string {
  const lines: string[] = []
  for (const p of purposes) {
    const items: string[] = []
    for (const [key, label] of Object.entries(EVENT_LABELS) as Array<
      [keyof BuildingPurposeRow['events'], string]
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

function formatTargets(targets: BuildingReport['body']['targets']): string {
  if (targets.length === 0) return ''
  const first = targets[0]
  const head = `${first.location}${first.houseNumber ? ` 家屋${first.houseNumber}` : ''}`.trim() || '-'
  if (targets.length === 1) return head
  return `${head} 他${targets.length - 1}棟`
}

function formatReportDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function BuildingReportPage() {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const byFarm = useBuildingReportStore((s) => s.byFarm)
  const loading = useBuildingReportStore((s) => s.loading)
  const error = useBuildingReportStore((s) => s.error)
  const fetchByFarm = useBuildingReportStore((s) => s.fetchByFarm)
  const createReport = useBuildingReportStore((s) => s.createReport)
  const deleteReport = useBuildingReportStore((s) => s.deleteReport)

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

  return (
    <div className="h-full flex flex-col">
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
            工区を選択してください。左メニューのプロジェクト/工区から対象の工区を選ぶと、その工区の建物調査報告書一覧が表示されます。
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
            この工区にはまだ建物調査報告書がありません。「新規作成」から追加してください。
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2 text-left border w-28">報告書番号</th>
                <th className="px-3 py-2 text-left border w-32">作成日</th>
                <th className="px-3 py-2 text-left border">登記の目的</th>
                <th className="px-3 py-2 text-left border">調査した建物</th>
                <th className="px-3 py-2 text-left border w-40">最終更新</th>
                <th className="px-3 py-2 text-left border w-28">操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const reportNo = r.body.meta.reportNo?.trim() || '—'
                const reportDate = formatReportDate(r.body.meta.reportDate)
                const purposesText = formatPurposes(r.body.purposes)
                const targetsText = formatTargets(r.body.targets)
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
                      {targetsText || '—'}
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
        <BuildingReportEditModal
          reportId={editingId}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
