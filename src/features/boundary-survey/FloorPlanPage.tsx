// 地籍測量: 各階平面図作成ページ。
//
// 今は メニュー と 経路 だけ の 置き場。 中身 (階ごと の 平面形状 / 求積) は これから。

import { LayoutTemplate } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'

export function FloorPlanPage() {
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
      <LayoutTemplate className="h-8 w-8 text-slate-300" />
      <div className="text-sm font-semibold text-slate-600">各階平面図作成</div>
      <div className="text-xs">この機能は準備中です。</div>
    </div>
  )
}
