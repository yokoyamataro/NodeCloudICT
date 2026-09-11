// サイトオーナー 向け の 使用状況。
//
// ユーザー 1 人 = 1 行 を RPC (get_site_usage_by_user) で 受け取り、
// 画面側 で 組織 ごと に まとめる。 「オーナーである 現場 の 数」 と
// その 配下の データ量 が 見たい、が 元の 要件。
//
// 注意: オルソタイル は 集計に 入っていない (storage の prefix 検索 が 重い)。
// 工区設定 の 「データ容量」 と 同じ 制限。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, HardDrive, Loader2, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errorMessage'

interface UsageRow {
  user_id: string
  user_name: string | null
  user_email: string | null
  organization_id: string | null
  organization_name: string | null
  project_count: number
  farm_count: number
  coordinate_count: number
  attachment_bytes: number
  attachment_count: number
  landxml_bytes: number
  farm_file_bytes: number
  total_bytes: number
}

interface OrgGroup {
  id: string
  name: string
  users: UsageRow[]
  projectCount: number
  farmCount: number
  coordinateCount: number
  totalBytes: number
}

const NO_ORG = '__none__'

function formatBytes(n: number): string {
  if (!n) return '0'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

export function SiteUsageView() {
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 現場も データも 無い ユーザー は 既定で 隠す (人数が 多いと 埋もれる) */
  const [showEmpty, setShowEmpty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: rpcErr } = (await supabase.rpc(
        'get_site_usage_by_user' as never,
      )) as unknown as { data: UsageRow[] | null; error: { message: string } | null }
      if (rpcErr) throw rpcErr
      setRows(data ?? [])
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo<OrgGroup[]>(() => {
    if (!rows) return []
    const m = new Map<string, OrgGroup>()
    for (const r of rows) {
      if (!showEmpty && r.project_count === 0 && r.total_bytes === 0) continue
      const id = r.organization_id ?? NO_ORG
      let g = m.get(id)
      if (!g) {
        g = {
          id,
          name: r.organization_name ?? '(組織なし)',
          users: [],
          projectCount: 0,
          farmCount: 0,
          coordinateCount: 0,
          totalBytes: 0,
        }
        m.set(id, g)
      }
      g.users.push(r)
      g.projectCount += r.project_count
      g.farmCount += r.farm_count
      g.coordinateCount += r.coordinate_count
      g.totalBytes += r.total_bytes
    }
    return Array.from(m.values()).sort((a, b) => b.totalBytes - a.totalBytes)
  }, [rows, showEmpty])

  const grand = useMemo(
    () =>
      groups.reduce(
        (acc, g) => ({
          projects: acc.projects + g.projectCount,
          farms: acc.farms + g.farmCount,
          coords: acc.coords + g.coordinateCount,
          bytes: acc.bytes + g.totalBytes,
        }),
        { projects: 0, farms: 0, coords: 0, bytes: 0 },
      ),
    [groups],
  )

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b bg-white flex items-center gap-2 flex-wrap">
        <HardDrive className="h-4 w-4 text-slate-500" />
        <span className="font-medium text-sm">使用状況</span>
        <span className="text-xs text-slate-500">
          現場 {grand.projects.toLocaleString()} / 工区 {grand.farms.toLocaleString()} / 座標{' '}
          {grand.coords.toLocaleString()} 点 / {formatBytes(grand.bytes)}
        </span>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showEmpty}
            onChange={() => setShowEmpty((v) => !v)}
            className="h-3.5 w-3.5"
          />
          現場もデータも無いユーザーを含む
        </label>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          再取得
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 whitespace-pre-line">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && !rows ? (
          <div className="flex items-center justify-center py-10 text-sm text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            集計中…
          </div>
        ) : groups.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400">対象がありません</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-100 text-[11px] text-slate-600">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">組織 / ユーザー</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">現場</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">工区</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">座標</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">写真/PDF</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">LandXML</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">ファイル</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">合計</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {groups.map((g) => {
                const open = expanded.has(g.id)
                return [
                  <tr
                    key={g.id}
                    className="bg-slate-50 font-medium cursor-pointer hover:bg-slate-100"
                    onClick={() => toggle(g.id)}
                  >
                    <td className="px-2 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                        )}
                        {g.name}
                        <span className="text-[10px] font-normal text-slate-400">
                          ({g.users.length} 人)
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{g.projectCount}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{g.farmCount}</td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {g.coordinateCount.toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">—</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">—</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">—</td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {formatBytes(g.totalBytes)}
                    </td>
                  </tr>,
                  ...(open
                    ? g.users.map((u) => (
                        <tr key={`${g.id}-${u.user_id}`} className="hover:bg-slate-50">
                          <td className="px-2 py-1 pl-8">
                            <div className="truncate">{u.user_name || '(氏名未登録)'}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {u.user_email ?? ''}
                            </div>
                          </td>
                          <td className="px-2 py-1 text-right font-mono">{u.project_count}</td>
                          <td className="px-2 py-1 text-right font-mono">{u.farm_count}</td>
                          <td className="px-2 py-1 text-right font-mono">
                            {u.coordinate_count.toLocaleString()}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {formatBytes(u.attachment_bytes)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {formatBytes(u.landxml_bytes)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {formatBytes(u.farm_file_bytes)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono font-medium">
                            {formatBytes(u.total_bytes)}
                          </td>
                        </tr>
                      ))
                    : []),
                ]
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-4 py-1.5 border-t bg-white text-[10px] text-slate-400">
        集計は「プロジェクト (現場) の所有者」単位。ゴミ箱の現場・工区は除外。
        オルソタイルは含まれません (工区設定の「データ容量」と同じ)。
      </div>
    </div>
  )
}
