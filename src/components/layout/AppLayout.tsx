import { Outlet, Link, useLocation } from 'react-router-dom'
import { Map, Database, Calculator, Layers, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const navigation = [
  { name: 'プロジェクト', href: '/', icon: Database },
  { name: '座標管理', href: '/coordinates', icon: Map },
  { name: '作業区域', href: '/work-zones', icon: Layers },
  { name: '水理計算', href: '/hydraulics', icon: Calculator },
  { name: '設定', href: '/settings', icon: Settings },
]

export function AppLayout() {
  const location = useLocation()

  return (
    <div className="min-h-screen flex">
      {/* サイドバー */}
      <aside className="w-64 bg-slate-900 text-white flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-xl font-bold">NodeCloud Design</h1>
          <p className="text-sm text-slate-400">ICT設計システム</p>
        </div>
        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <li key={item.name}>
                  <Link
                    to={item.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    )}
                  >
                    <item.icon className="h-5 w-5" />
                    {item.name}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="p-4 border-t border-slate-700 text-xs text-slate-400">
          v0.1.0
        </div>
      </aside>

      {/* メインコンテンツ */}
      <main className="flex-1 bg-slate-50">
        <Outlet />
      </main>
    </div>
  )
}
