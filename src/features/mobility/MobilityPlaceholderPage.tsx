// モビリティ機能 (現在地・走行ログ) のプレースホルダページ。
//
// ゲート: useCanUseMobility() が false の場合は /login に飛ばす。
// 実体: 別アプリ (mobility.nodecloud.jp) に切り出す予定。この画面は
//   ChooserPage の「モビリティを開く」を実装する前の中継地点。
// 差し替え時期: 別ドメイン + SSO が動き始めたら、このページを外して
//   ChooserPage のタイルから `window.location.href = ...` へ直遷移させる。

import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowLeft, Car, Construction } from 'lucide-react'
import { useCanUseMobility } from '@/lib/useCanUseMobility'

export function MobilityPlaceholderPage() {
  const navigate = useNavigate()
  const canUse = useCanUseMobility()
  if (!canUse) return <Navigate to="/" replace />

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-4 bg-white border-b flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="現場一覧に戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Car className="h-5 w-5 text-indigo-600" />
        <h1 className="text-lg font-bold">モビリティ</h1>
        <span className="ml-2 px-2 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 border border-amber-300">
          開発中
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-xl border shadow-sm p-8 text-center">
          <Construction className="h-12 w-12 text-indigo-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold mb-2">
            モビリティ機能は準備中です
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-4">
            社員・車両・重機の現在地の把握と走行ログを管理する機能を準備しています。
            正式リリース時には、専用アプリ
            <span className="text-slate-800 font-medium"> mobility.nodecloud.jp </span>
            へ切り替わります。
          </p>
          <div className="text-xs text-slate-500 border-t pt-4">
            この画面はサイトオーナー向けのプレビューです。
          </div>
        </div>
      </div>
    </div>
  )
}
