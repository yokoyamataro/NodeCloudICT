// 土地調査報告書作成 (境界測量) - プレースホルダ
// 実装は 次フェーズで。現状は 準備中の案内のみを表示する。

import { FileText } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'

export function LandReportPage() {
  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="土地調査報告書作成"
        icon={<FileText className="h-5 w-5" />}
      />
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        準備中: 土地調査報告書の作成機能は今後実装予定です。
      </div>
    </div>
  )
}
