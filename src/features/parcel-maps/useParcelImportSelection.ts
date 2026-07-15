// 法務省地図 (地番) からの一括取込用の選択状態を管理する共通フック。
// 座標管理 / 全体図 / 地番管理 のどこからでも同じ挙動で使える。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Feature, Polygon } from 'geojson'
import { parcelFeatureKey } from '@/components/map/ParcelMapLayer'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import {
  importParcelBatch,
  type ImportParcelBatchResult,
} from './importParcelBatch'

export interface UseParcelImportSelectionResult {
  selectionMode: boolean
  setSelectionMode: (v: boolean) => void
  selectedParcels: Map<string, Feature<Polygon, ParcelFeatureProperties>>
  selectedKeys: Set<string>
  toggleSelect: (feature: Feature<Polygon, ParcelFeatureProperties>) => void
  clearSelection: () => void
  busy: boolean
  message: string | null
  setMessage: (m: string | null) => void
  /** 選択中の地番を実際に取り込む。成功時は選択をリセットする */
  importSelected: (farmId: string, zone: number) => Promise<void>
}

/**
 * @param opts.resetTrigger 値が変わったら選択モード / 選択集合をクリアする。
 *   通常は `showParcelMap` (法務省地図トグル) を渡して OFF 時に自動リセットさせる。
 */
export function useParcelImportSelection(opts?: {
  resetTrigger?: unknown
}): UseParcelImportSelectionResult {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedParcels, setSelectedParcels] = useState<
    Map<string, Feature<Polygon, ParcelFeatureProperties>>
  >(new Map())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const selectedKeys = useMemo(
    () => new Set(selectedParcels.keys()),
    [selectedParcels],
  )

  const toggleSelect = useCallback(
    (feature: Feature<Polygon, ParcelFeatureProperties>) => {
      const key = parcelFeatureKey(feature)
      setSelectedParcels((prev) => {
        const next = new Map(prev)
        if (next.has(key)) next.delete(key)
        else next.set(key, feature)
        return next
      })
    },
    [],
  )

  const clearSelection = useCallback(() => setSelectedParcels(new Map()), [])

  // resetTrigger が変わったら (法務省地図 OFF 等) 選択状態をリセット
  const trigger = opts?.resetTrigger
  useEffect(() => {
    setSelectionMode(false)
    setSelectedParcels(new Map())
  }, [trigger])

  const importSelected = useCallback(
    async (farmId: string, zone: number) => {
      if (selectedParcels.size === 0) return
      setBusy(true)
      setMessage(null)
      try {
        const result: ImportParcelBatchResult = await importParcelBatch(
          Array.from(selectedParcels.values()),
          { farmId, zone },
        )
        setSelectedParcels(new Map())
        setSelectionMode(false)
        setMessage(result.message)
      } catch (err) {
        console.error(err)
        setMessage(err instanceof Error ? err.message : '取込に失敗しました')
      } finally {
        setBusy(false)
      }
    },
    [selectedParcels],
  )

  return {
    selectionMode,
    setSelectionMode,
    selectedParcels,
    selectedKeys,
    toggleSelect,
    clearSelection,
    busy,
    message,
    setMessage,
    importSelected,
  }
}
