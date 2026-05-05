import { useState } from 'react'
import { Loader2, X, FileSpreadsheet } from 'lucide-react'
import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import type { Farm } from '@/stores/farmStore'
import { exportHydraulicCalcSheet, type HydraulicCalcSettings } from '@/lib/hydraulicCalcExport'
import { useHydraulicSettingsStore } from '@/stores/hydraulicSettingsStore'

interface HydraulicCalcModalProps {
  open: boolean
  onClose: () => void
  planGroups: PlanGroup[]
  pipes: PipeRow[]
  farm: Farm | null
}

export function HydraulicCalcModal({ open, onClose, planGroups, pipes, farm }: HydraulicCalcModalProps) {
  const { getSettings } = useHydraulicSettingsStore()
  const settings = getSettings(farm?.id ?? null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const exportSettings: HydraulicCalcSettings = {
        plannedFlow: settings.plannedFlow,
        pipeInterval: settings.pipeInterval,
        absorptionPipeType: settings.absorptionPipeType,
        collectorPipeType: settings.collectorPipeType,
        lengthDecimals: settings.lengthDecimals,
      }
      await exportHydraulicCalcSheet({
        settings: exportSettings,
        planGroups,
        pipes,
        farm,
      })
      onClose()
    } catch (err) {
      console.error('水理計算書の生成に失敗:', err)
      setError(err instanceof Error ? err.message : '水理計算書の生成に失敗しました')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-green-600" />
            水理計算書の作成
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2 text-sm">
          <div className="text-xs text-slate-500">
            水理計算の設定は配管系統画面右上の「設定」から変更できます。
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border rounded p-3 bg-slate-50">
            <dt className="text-slate-600">計画流量</dt>
            <dd className="font-mono text-right">{settings.plannedFlow} mm/day</dd>
            <dt className="text-slate-600">配線間隔</dt>
            <dd className="font-mono text-right">{settings.pipeInterval} m</dd>
            <dt className="text-slate-600">吸水管種</dt>
            <dd className="font-mono text-right">
              {settings.absorptionPipeType}: {settings.absorptionPipeType === 1 ? '素焼土管' : '合成樹脂管'}
            </dd>
            <dt className="text-slate-600">集水管種</dt>
            <dd className="font-mono text-right">
              {settings.collectorPipeType}: {settings.collectorPipeType === 1 ? '素焼土管' : '合成樹脂管'}
            </dd>
            <dt className="text-slate-600">実延長の丸め</dt>
            <dd className="font-mono text-right">{settings.lengthDecimals} 桁</dd>
          </dl>

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            disabled={generating}
            className="px-4 py-2 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
          >
            {generating && <Loader2 className="h-4 w-4 animate-spin" />}
            {generating ? '生成中...' : '生成してダウンロード'}
          </button>
        </div>
      </div>
    </div>
  )
}
