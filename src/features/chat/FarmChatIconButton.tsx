// 工区一覧の右端に置くチャットアイコンボタン。
// 未読数を赤バッジで表示。onClick で親が FarmChatSheet を開く想定。

import { MessageSquare } from 'lucide-react'
import { useFarmChatStore } from '@/stores/farmChatStore'

interface Props {
  farmId: string
  onClick: () => void
  size?: 'sm' | 'md'
}

export function FarmChatIconButton({ farmId, onClick, size = 'sm' }: Props) {
  const unread = useFarmChatStore((s) => s.unreadByFarm.get(farmId) ?? 0)
  const iconClass = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
  const btnClass = size === 'sm' ? 'p-1' : 'p-1.5'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`relative inline-flex items-center justify-center rounded ${btnClass} text-slate-500 hover:bg-slate-100 hover:text-indigo-700`}
      title={unread > 0 ? `未読 ${unread} 件` : 'チャットを開く'}
    >
      <MessageSquare className={iconClass} />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}
