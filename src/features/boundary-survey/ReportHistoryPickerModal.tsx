// 06 原本確認結果 / 09 三角点測量できない理由 / 10 補足特記事項 で
// 社内 (組織) の 過去 land_reports から 該当セクションの本文を取込むモーダル。
//
// スコープ:
//   * 組織 (organization) 配下の 全プロジェクト → 全 farm → 全 land_reports
//     を対象に、body の 該当パスから 文字列を抽出
//   * 空文字は除外、更新日時降順で表示
//   * 選択 → 「取り込む」で 現在編集中の本文に上書き

import { useEffect, useMemo, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

/** body から 該当パスの 文字列を取り出す */
export type ReportHistoryField = 'originalCheck' | 'noTriangulationReason' | 'remark'

function pickField(body: unknown, field: ReportHistoryField): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  if (field === 'originalCheck') {
    const v = b.originalCheck
    return typeof v === 'string' ? v : ''
  }
  if (field === 'remark') {
    const v = b.remark
    return typeof v === 'string' ? v : ''
  }
  if (field === 'noTriangulationReason') {
    const boundary = b.boundary as Record<string, unknown> | undefined
    const v = boundary?.noBaseTriangulationReason
    return typeof v === 'string' ? v : ''
  }
  return ''
}

interface Props {
  field: ReportHistoryField
  title: string
  onCancel: () => void
  onConfirm: (body: string) => void
}

interface Row {
  id: string
  title: string
  body: unknown
  updated_at: string
  farm_id: string
}

interface Entry {
  reportId: string
  reportTitle: string
  farmName: string
  projectName: string
  updatedAt: string
  body: string
}

export function ReportHistoryPickerModal({ field, title, onCancel, onConfirm }: Props) {
  const { user, profile } = useAuth()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        // 組織 ID を解決 (profile 優先, なければ organization_members)
        let orgId = profile?.organization_id ?? null
        if (!orgId) {
          const { data: memberRow } = await supabase
            .from('organization_members')
            .select('organization_id')
            .eq('user_id', user.id)
            .limit(1)
            .maybeSingle<{ organization_id: string }>()
          orgId = memberRow?.organization_id ?? null
        }
        if (!orgId) {
          setError('所属組織が特定できません')
          setEntries([])
          setLoading(false)
          return
        }

        // 組織配下の projects を fetch
        const { data: projects } = await supabase
          .from('projects')
          .select('id, name')
          .eq('organization_id', orgId)
        const projectIds = ((projects ?? []) as { id: string; name: string }[]).map((p) => p.id)
        const projectNameById = new Map<string, string>()
        for (const p of ((projects ?? []) as { id: string; name: string }[])) {
          projectNameById.set(p.id, p.name)
        }
        if (projectIds.length === 0) {
          setEntries([])
          setLoading(false)
          return
        }

        // 該当 projects の farms を fetch
        const { data: farms } = await supabase
          .from('farms')
          .select('id, name, project_id')
          .in('project_id', projectIds)
        const farmIds = ((farms ?? []) as { id: string; name: string; project_id: string }[]).map(
          (f) => f.id,
        )
        const farmMap = new Map<string, { name: string; projectId: string }>()
        for (const f of ((farms ?? []) as { id: string; name: string; project_id: string }[])) {
          farmMap.set(f.id, { name: f.name, projectId: f.project_id })
        }
        if (farmIds.length === 0) {
          setEntries([])
          setLoading(false)
          return
        }

        // 該当 farms の land_reports を fetch
        const { data: reports } = await supabase
          .from('land_reports')
          .select('id, title, body, updated_at, farm_id')
          .in('farm_id', farmIds)
          .order('updated_at', { ascending: false })

        if (cancelled) return
        const list: Entry[] = []
        for (const r of ((reports ?? []) as Row[])) {
          const body = pickField(r.body, field).trim()
          if (!body) continue
          const farm = farmMap.get(r.farm_id)
          const projectName = farm ? projectNameById.get(farm.projectId) ?? '' : ''
          list.push({
            reportId: r.id,
            reportTitle: r.title,
            farmName: farm?.name ?? '',
            projectName,
            updatedAt: r.updated_at,
            body,
          })
        }
        setEntries(list)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, profile?.organization_id, field])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.reportTitle.toLowerCase().includes(q) ||
        e.farmName.toLowerCase().includes(q) ||
        e.projectName.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q),
    )
  }, [entries, filter])

  const handleConfirm = () => {
    const chosen = entries.find((e) => e.reportId === selectedId)
    if (chosen) onConfirm(chosen.body)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold flex-1">{title} — 過去の報告書から取り込み</h3>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 hover:bg-slate-100 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3 border-b">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="タイトル・工区・プロジェクト・本文でフィルタ"
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3">
          {error ? (
            <div className="text-xs text-red-700">{error}</div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : entries.length === 0 ? (
            <div className="text-xs text-slate-400">
              過去の報告書に この項目の記入がある行が 見つかりませんでした。
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((e) => {
                const isSel = selectedId === e.reportId
                return (
                  <label
                    key={e.reportId}
                    className={`block p-2 border rounded cursor-pointer ${
                      isSel ? 'bg-blue-50 border-blue-400' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="report-history"
                        checked={isSel}
                        onChange={() => setSelectedId(e.reportId)}
                        className="mt-0.5 h-3.5 w-3.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium">{e.reportTitle}</span>
                          <span className="text-slate-500">
                            {[e.projectName, e.farmName].filter(Boolean).join(' / ')}
                          </span>
                          <span className="ml-auto text-[10px] text-slate-400">
                            {new Date(e.updatedAt).toLocaleDateString('ja-JP')}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-600 whitespace-pre-wrap line-clamp-4 border-l-2 border-slate-200 pl-2">
                          {e.body}
                        </div>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t px-4 py-3 flex items-center gap-2">
          <span className="text-xs text-slate-500">{entries.length} 件</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selectedId}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> 取り込む
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
