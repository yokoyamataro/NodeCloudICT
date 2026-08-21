// スマホページ共通のハンバーガーメニュー。
// 左上の Menu アイコン → ドロワー (左スライド) が開き、下記に導線を提供する:
//   ・座標一覧    → /mobile/staking?openCoords=1 に遷移
//                   (既に staking ページなら座標一覧パネルを開く)
//   ・設定       → ログイン情報 (メール / ログアウト) をモーダルで表示
//
// 現状スマホ用の独立した設定ページは無いので、v1 は「設定」= ログイン情報 の
// シンプル表示に留める。touki.or.jp 認証情報等の細かい設定は PC 表示で。

import { useState } from 'react'
import { Menu, X, LogOut, ListOrdered, Settings2, Monitor } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { setDisplayModeOverride } from '@/lib/displayMode'

interface Props {
  /** 現在の工区 ID。座標一覧遷移時に farmId=xxx を付与する用。 */
  farmId?: string | null
  /** 「座標一覧」を選んだときの追加処理。既に staking ページに居るなら
   *  showRecordList を true にするなど、親側で挙動を指定できる。渡されない
   *  場合は staking ページへ URL 遷移する。 */
  onOpenCoords?: () => void
}

export function MobileHamburgerMenu({ farmId, onOpenCoords }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { user, displayName, signOut } = useAuth()
  const navigate = useNavigate()

  const handleCoords = () => {
    setDrawerOpen(false)
    if (onOpenCoords) {
      onOpenCoords()
      return
    }
    const params = new URLSearchParams()
    if (farmId) params.set('farmId', farmId)
    params.set('openCoords', '1')
    navigate(`/mobile/staking?${params.toString()}`)
  }

  const handleSettings = () => {
    setDrawerOpen(false)
    setSettingsOpen(true)
  }

  const handleSwitchToPc = () => {
    setDrawerOpen(false)
    setDisplayModeOverride('pc')
    navigate('/')
  }

  const handleSignOut = async () => {
    if (!confirm('ログアウトしますか？')) return
    setSettingsOpen(false)
    await signOut()
    navigate('/login')
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="p-1.5 rounded hover:bg-slate-700"
        title="メニュー"
        aria-label="メニュー"
      >
        <Menu className="h-4 w-4" />
      </button>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-[3000] bg-black/40"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-64 max-w-[80%] bg-white text-slate-800 shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b bg-slate-50 flex items-center justify-between">
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold text-slate-700">NodeCloud</span>
                <span className="text-[10px] text-slate-500 mt-0.5">{__BUILD_TIME__}</span>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="p-1 rounded hover:bg-slate-200"
                aria-label="閉じる"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="px-4 py-3 border-b">
              <div className="text-[11px] text-slate-500">ログイン中</div>
              <div
                className="text-xs font-semibold text-slate-800 truncate"
                title={displayName || user?.email || ''}
              >
                {displayName || '(名前未設定)'}
              </div>
              <div
                className="text-[11px] text-slate-500 truncate"
                title={user?.email ?? ''}
              >
                {user?.email ?? '(メール不明)'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCoords}
              className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50 border-b"
            >
              <ListOrdered className="h-4 w-4 text-slate-500" />
              座標一覧
            </button>
            <button
              type="button"
              onClick={handleSwitchToPc}
              className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50 border-b"
            >
              <Monitor className="h-4 w-4 text-slate-500" />
              PC表示へ切替
            </button>
            <button
              type="button"
              onClick={handleSettings}
              className="w-full flex items-center gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50"
            >
              <Settings2 className="h-4 w-4 text-slate-500" />
              設定（ログイン情報）
            </button>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-[3100] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="bg-white text-slate-800 rounded-lg shadow-xl w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <span className="text-sm font-semibold">設定 / ログイン情報</span>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1 rounded hover:bg-slate-100"
                aria-label="閉じる"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <div className="text-[11px] text-slate-500">ユーザー名</div>
                <div
                  className="text-sm font-semibold text-slate-800 break-all"
                  title={displayName || user?.email || ''}
                >
                  {displayName || '(名前未設定)'}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">メールアドレス</div>
                <div
                  className="text-sm text-slate-800 break-all"
                  title={user?.email ?? ''}
                >
                  {user?.email ?? '(不明)'}
                </div>
              </div>
              <div className="text-[11px] text-slate-500 leading-relaxed border-t pt-3">
                touki.or.jp 認証情報等の詳細設定は PC 表示から
                「設定 → 登記情報」で行えます。
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center justify-center gap-2 py-2 text-sm border border-slate-300 rounded hover:bg-slate-50 text-slate-700"
              >
                <LogOut className="h-4 w-4" />
                ログアウト
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
