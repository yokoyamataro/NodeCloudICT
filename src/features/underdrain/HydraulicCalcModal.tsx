import { useState } from 'react'
import { Loader2, X, FileSpreadsheet } from 'lucide-react'
import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import type { Farm } from '@/stores/farmStore'
import { exportHydraulicCalcSheet, type HydraulicCalcSettings } from '@/lib/hydraulicCalcExport'

interface HydraulicCalcModalProps {
  open: boolean
  onClose: () => void
  planGroups: PlanGroup[]
  pipes: PipeRow[]
  farm: Farm | null
}

export function HydraulicCalcModal({ open, onClose, planGroups, pipes, farm }: HydraulicCalcModalProps) {
  const [plannedFlow, setPlannedFlow] = useState(30)
  const [pipeInterval, setPipeInterval] = useState<10 | 12>(10)
  const [absorptionPipeType, setAbsorptionPipeType] = useState<1 | 2>(2)
  const [collectorPipeType, setCollectorPipeType] = useState<1 | 2>(2)
  const [lengthDecimals, setLengthDecimals] = useState<0 | 1 | 2>(1)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const settings: HydraulicCalcSettings = {
        plannedFlow,
        pipeInterval,
        absorptionPipeType,
        collectorPipeType,
        lengthDecimals,
      }
      await exportHydraulicCalcSheet({
        settings,
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

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">計画流量 (mm/day)</label>
            <input
              type="number"
              step="0.1"
              value={plannedFlow}
              onChange={(e) => setPlannedFlow(parseFloat(e.target.value) || 0)}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">配線間隔 (m)</label>
            <select
              value={pipeInterval}
              onChange={(e) => setPipeInterval(parseInt(e.target.value) as 10 | 12)}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={10}>10m</option>
              <option value={12}>12m</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">吸水管種</label>
              <select
                value={absorptionPipeType}
                onChange={(e) => setAbsorptionPipeType(parseInt(e.target.value) as 1 | 2)}
                className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={1}>1: 素焼土管</option>
                <option value={2}>2: 合成樹脂管</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">集水管種</label>
              <select
                value={collectorPipeType}
                onChange={(e) => setCollectorPipeType(parseInt(e.target.value) as 1 | 2)}
                className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={1}>1: 素焼土管</option>
                <option value={2}>2: 合成樹脂管</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">実延長の丸め桁数</label>
            <select
              value={lengthDecimals}
              onChange={(e) => setLengthDecimals(parseInt(e.target.value) as 0 | 1 | 2)}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={0}>0 桁（整数）</option>
              <option value={1}>1 桁（例: 12.3）</option>
              <option value={2}>2 桁（例: 12.34）</option>
            </select>
          </div>

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
