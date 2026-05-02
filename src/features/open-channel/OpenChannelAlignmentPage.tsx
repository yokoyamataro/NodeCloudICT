// 小水路（明渠）— 線形登録ページ（プレースホルダー）
//
// 仕様（予定）:
//   - 線形は座標管理の点を参照して BP（起点）→ IP1, IP2, ... → EP（終点）で構成
//   - 各 IP は折点（角）または単曲線（R）を選択
//   - 断面は床幅 W（m）と斜面勾配 1:i で定義
//   - 区域は持たない（線形 + 断面のみ）

import { PageHeader } from '@/components/layout/PageHeader'

export function OpenChannelAlignmentPage() {
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="小水路 線形登録" subtitle="小水路（明渠） / 線形 + 断面" />
      <div className="flex-1 p-6 overflow-auto bg-slate-50">
        <div className="max-w-2xl mx-auto bg-white border rounded-lg p-6 space-y-3">
          <h2 className="text-base font-bold text-slate-800">小水路の定義（実装予定）</h2>
          <p className="text-sm text-slate-600">
            小水路（明渠）は、区域ではなく <strong>線形</strong> と <strong>断面</strong> で定義する工種です。
            次のステップで線形登録ページを実装します。
          </p>
          <div className="text-sm text-slate-700 space-y-1">
            <div className="font-medium">線形:</div>
            <ul className="list-disc list-inside text-slate-600 ml-2 space-y-0.5">
              <li>BP（起点）— 座標管理の点を参照</li>
              <li>IP1, IP2, ... — 折点。各 IP は「角」または「単曲線（R 値あり）」</li>
              <li>EP（終点）</li>
            </ul>
          </div>
          <div className="text-sm text-slate-700 space-y-1 pt-2">
            <div className="font-medium">断面:</div>
            <ul className="list-disc list-inside text-slate-600 ml-2 space-y-0.5">
              <li>床幅 W（m）— 中心 ±W/2 が水平な床</li>
              <li>斜面勾配 1:i — 床端から外側 sw 進むと高さ sw/i だけ上がる</li>
            </ul>
          </div>
          <div className="pt-3 text-xs text-slate-400 border-t">
            次フェーズ B で線形 / 断面の登録 UI と地図プレビュー、フェーズ C で床掘ジオメトリ生成を実装。
          </div>
        </div>
      </div>
    </div>
  )
}
