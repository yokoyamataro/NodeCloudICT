import { useEffect, useState } from 'react'
import { Loader2, X, Download } from 'lucide-react'
import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import type { Farm } from '@/stores/farmStore'
import { exportMeasurementResult } from '@/lib/measurementResultExport'
import { useHydraulicSettingsStore } from '@/stores/hydraulicSettingsStore'

interface MeasurementResultModalProps {
  open: boolean
  onClose: () => void
  planGroups: PlanGroup[]
  pipes: PipeRow[]
  farm: Farm | null
}

export function MeasurementResultModal({
  open,
  onClose,
  planGroups,
  pipes,
  farm,
}: MeasurementResultModalProps) {
  const { getSettings } = useHydraulicSettingsStore()
  const settings = getSettings(farm?.id ?? null)

  const [farmNumber, setFarmNumber] = useState('')
  const [area, setArea] = useState('')
  const [beneficiary, setBeneficiary] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && farm && !farmNumber) {
      setFarmNumber(farm.name)
    }
  }, [open, farm, farmNumber])

  if (!open) return null

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      await exportMeasurementResult({
        pipes,
        planGroups,
        header: {
          farmNumber,
          area,
          beneficiary,
          spacing: settings.pipeInterval,
        },
        farmName: farm?.name,
      })
      onClose()
    } catch (err) {
      console.error('測定結果一覧表の出力に失敗:', err)
      setError(err instanceof Error ? err.message : '測定結果一覧表の出力に失敗しました')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Download className="h-5 w-5 text-blue-600" />
            測定結果一覧表の出力
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">工区番号</span>
            <input
              type="text"
              value={farmNumber}
              onChange={(e) => setFarmNumber(e.target.value)}
              className="px-2 py-1.5 border rounded text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">面積</span>
            <input
              type="text"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="例: 1.23 ha"
              className="px-2 py-1.5 border rounded text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-600">受益者名</span>
            <input
              type="text"
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
              className="px-2 py-1.5 border rounded text-sm"
            />
          </label>

          <div className="text-xs text-slate-500 border rounded p-2 bg-slate-50">
            配線間隔 <span className="font-mono">{settings.pipeInterval} m</span> はツールバーの値を使用します。
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
            disabled={generating || pipes.length === 0}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {generating ? '出力中...' : '出力（Excel）'}
          </button>
        </div>
      </div>
    </div>
  )
}
