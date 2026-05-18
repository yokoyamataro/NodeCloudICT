import { X } from 'lucide-react'
import {
  useHydraulicSettingsStore,
  type HydraulicSettings,
} from '@/stores/hydraulicSettingsStore'

/**
 * 水理計算（許容勾配 / 水理計算書）共通の設定モーダル。
 * 工区ごとに設定を持ち、保存は localStorage（Zustand persist）。
 */
export function HydraulicSettingsModal({
  open,
  onClose,
  farmId,
}: {
  open: boolean
  onClose: () => void
  farmId: string | null
}) {
  const { getSettings, setSettings } = useHydraulicSettingsStore()
  const settings: HydraulicSettings = getSettings(farmId)

  if (!open) return null

  const update = (patch: Partial<HydraulicSettings>) => {
    if (!farmId) return
    setSettings(farmId, patch)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">水理計算 設定</h2>
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
              value={settings.plannedFlow}
              onChange={(e) => update({ plannedFlow: parseFloat(e.target.value) || 0 })}
              disabled={!farmId}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">配線間隔 (m)</label>
            <select
              value={settings.pipeInterval}
              onChange={(e) =>
                update({ pipeInterval: parseInt(e.target.value) as 10 | 12 })
              }
              disabled={!farmId}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100"
            >
              <option value={10}>10m</option>
              <option value={12}>12m</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">吸水管種</label>
              <select
                value={settings.absorptionPipeType}
                onChange={(e) =>
                  update({ absorptionPipeType: parseInt(e.target.value) as 1 | 2 })
                }
                disabled={!farmId}
                className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100"
              >
                <option value={1}>1: 素焼土管</option>
                <option value={2}>2: 合成樹脂管</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">集水管種</label>
              <select
                value={settings.collectorPipeType}
                onChange={(e) =>
                  update({ collectorPipeType: parseInt(e.target.value) as 1 | 2 })
                }
                disabled={!farmId}
                className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100"
              >
                <option value={1}>1: 素焼土管</option>
                <option value={2}>2: 合成樹脂管</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">実延長の丸め桁数</label>
            <select
              value={settings.lengthDecimals}
              onChange={(e) =>
                update({ lengthDecimals: parseInt(e.target.value) as 0 | 1 | 2 })
              }
              disabled={!farmId}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-100"
            >
              <option value={0}>0 桁（整数）</option>
              <option value={1}>1 桁（例: 12.3）</option>
              <option value={2}>2 桁（例: 12.34）</option>
            </select>
          </div>

          {!farmId && (
            <div className="p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              工区が選択されていません。
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
