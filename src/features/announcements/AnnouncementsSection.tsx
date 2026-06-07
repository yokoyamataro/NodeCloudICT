// 工事一覧（トップページ）の上に出る「お知らせ」セクション。
// - 未読のお知らせをすべて表示
// - 各お知らせに「確認しました」チェック欄を設け、押すと announcement_reads に
//   行が挿入されて以後は表示されなくなる
// - 既読の履歴も「過去のお知らせ」リンクから開けるようにしておく
// - お知らせが 0 件 / 全て既読のときは何も描画しない（ページの構造を圧迫しない）

import { useCallback, useEffect, useState } from 'react'
import { Bell, ChevronDown, ChevronRight, Check, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Announcement } from '@/types/database'

export function AnnouncementsSection() {
  const { user } = useAuth()
  const [unread, setUnread] = useState<Announcement[]>([])
  const [read, setRead] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [showRead, setShowRead] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [marking, setMarking] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      const [annRes, readRes] = await Promise.all([
        supabase.from('announcements').select('*').order('published_at', { ascending: false }),
        supabase.from('announcement_reads').select('announcement_id').eq('user_id', user.id),
      ])
      if (annRes.error) throw annRes.error
      if (readRes.error) throw readRes.error
      const announcements = (annRes.data ?? []) as Announcement[]
      const readSet = new Set<string>(
        (readRes.data ?? []).map((r: { announcement_id: string }) => r.announcement_id),
      )
      setUnread(announcements.filter((a) => !readSet.has(a.id)))
      setRead(announcements.filter((a) => readSet.has(a.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'お知らせの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const handleMarkRead = async (id: string) => {
    if (!user) return
    setMarking((prev) => new Set(prev).add(id))
    try {
      const { error: insErr } = await supabase
        .from('announcement_reads')
        .insert({ announcement_id: id, user_id: user.id } as never)
      if (insErr) {
        // ON CONFLICT 相当の重複は無視
        if (!/duplicate|unique/i.test(insErr.message)) throw insErr
      }
      // ローカル状態を即時更新
      const target = unread.find((a) => a.id === id)
      if (target) {
        setUnread((prev) => prev.filter((a) => a.id !== id))
        setRead((prev) => [target, ...prev])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'チェックに失敗しました')
    } finally {
      setMarking((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  if (loading && unread.length === 0 && read.length === 0) {
    return null
  }
  if (unread.length === 0 && read.length === 0 && !error) {
    return null
  }

  return (
    <div className="bg-white border-b">
      <div className="p-4 space-y-3">
        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
            {error}
          </div>
        )}

        {/* 未読お知らせ */}
        {unread.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-amber-800">
              <Bell className="h-4 w-4" />
              <h2 className="text-sm font-semibold">
                お知らせ ({unread.length} 件未読)
              </h2>
            </div>
            <ul className="space-y-2">
              {unread.map((a) => (
                <li
                  key={a.id}
                  className="border border-amber-200 bg-amber-50/40 rounded p-3"
                >
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-base font-semibold text-slate-800 flex-1">
                      {a.title}
                    </span>
                    <span className="text-[11px] text-slate-500 shrink-0">
                      {new Date(a.published_at).toLocaleString('ja-JP')}
                    </span>
                  </div>
                  <div className="text-sm text-slate-700 whitespace-pre-wrap mb-2">
                    {a.body}
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => handleMarkRead(a.id)}
                      disabled={marking.has(a.id)}
                      className="flex items-center gap-1 px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                    >
                      {marking.has(a.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      確認しました
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 既読履歴 */}
        {read.length > 0 && (
          <div>
            <button
              onClick={() => setShowRead((v) => !v)}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              {showRead ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              過去のお知らせ ({read.length} 件)
            </button>
            {showRead && (
              <ul className="mt-2 space-y-2">
                {read.map((a) => (
                  <li
                    key={a.id}
                    className="border border-slate-200 bg-slate-50/50 rounded p-3 opacity-80"
                  >
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-sm font-semibold text-slate-700 flex-1">
                        {a.title}
                      </span>
                      <span className="text-[11px] text-slate-500 shrink-0">
                        {new Date(a.published_at).toLocaleString('ja-JP')}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 whitespace-pre-wrap">
                      {a.body}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
