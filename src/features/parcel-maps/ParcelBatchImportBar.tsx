// 法務省地図 (地番) 一括取込ボタン UI。
// selection state は useParcelImportSelection() で作って渡す。座標管理 /
// 全体図 / 地番管理 で共通して同じ見た目を出すために切り出している。

import { Download, Loader2, X } from 'lucide-react'
import type { UseParcelImportSelectionResult } from './useParcelImportSelection'

interface Props {
  /** ボタンを押したときに取込を行う対象工区 (未選択なら disabled) */
  farmId: string | null
  /** 対象工区の座標系番号 (未選択なら disabled) */
  zone: number | null
  /** 選択状態 (useParcelImportSelection の戻り値) */
  selection: UseParcelImportSelectionResult
}

export function ParcelBatchImportBar({ farmId, zone, selection }: Props) {
  const {
    selectionMode,
    setSelectionMode,
    selectedParcels,
    clearSelection,
    busy,
    importSelected,
  } = selection

  const disabled = busy || !farmId || zone === null

  return (
    <div className="flex items-center gap-1">
      {selectionMode && selectedParcels.size > 0 && (
        <button
          onClick={clearSelection}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1.5 text-sm border rounded shadow bg-white text-slate-700 border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          title="選択を全て解除"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <button
        onClick={() => {
          if (!selectionMode) {
            setSelectionMode(true)
          } else if (selectedParcels.size === 0) {
            setSelectionMode(false)
          } else if (farmId && zone !== null) {
            void importSelected(farmId, zone)
          }
        }}
        disabled={disabled}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
          !selectionMode
            ? 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            : selectedParcels.size === 0
              ? 'bg-blue-500 text-white border-blue-500 hover:bg-blue-600'
              : 'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700'
        } disabled:opacity-50`}
        title={
          !selectionMode
            ? '地番を選択して工区に取り込むモードに入る'
            : selectedParcels.size === 0
              ? '選択モードをキャンセル'
              : '選択中の地番を工区に取り込む'
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {!selectionMode
          ? '地番データ取込'
          : selectedParcels.size === 0
            ? '選択中… (キャンセル)'
            : `取り込む (${selectedParcels.size} 件)`}
      </button>
    </div>
  )
}
