// 地籍測量: 地積測量図作成ページ。
//
// 今は メニュー と 経路 だけ の 置き場。 中身 (求積表 / 図面出力) は これから。

import { Ruler } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'

export function LandSurveyDrawingPage() {
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
      <Ruler className="h-8 w-8 text-slate-300" />
      <div className="text-sm font-semibold text-slate-600">地積測量図作成</div>
      <div className="text-xs">この機能は準備中です。</div>
    </div>
  )
}
