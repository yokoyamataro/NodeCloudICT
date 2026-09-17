// 地籍測量: 法務局備付地図作成作業 の ページ。
//
// 今は メニュー と 経路 だけ の 置き場。 中身 は これから。

import { Map as MapIcon } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'

export function RegistryMapWorkPage() {
  const { currentFarm } = useFarmStore()

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-500">
      <MapIcon className="h-8 w-8 text-slate-300" />
      <div className="text-sm font-semibold text-slate-600">法務局備付地図作成作業</div>
      <div className="text-xs">この機能は準備中です。</div>
    </div>
  )
}
