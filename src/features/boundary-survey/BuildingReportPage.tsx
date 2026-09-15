// 地籍測量: 建物調査報告書作成ページ。
//
// 今は メニュー と 経路 だけ の 置き場。 中身 (調査項目 / 報告書出力) は これから。

import { Building2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'

export function BuildingReportPage() {
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
      <Building2 className="h-8 w-8 text-slate-300" />
      <div className="text-sm font-semibold text-slate-600">建物調査報告書作成</div>
      <div className="text-xs">この機能は準備中です。</div>
    </div>
  )
}
