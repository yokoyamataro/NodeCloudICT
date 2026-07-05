import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, RotateCcw, Loader2, AlertTriangle } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { TRASH_RETENTION_DAYS, daysUntilPurge } from '@/lib/trash'

function fmtDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtRemaining(days: number | null): { text: string; expired: boolean } {
  if (days == null) return { text: '-', expired: false }
  if (days <= 0) return { text: '削除待ち', expired: true }
  if (days < 1) return { text: `残り約 ${Math.max(1, Math.round(days * 24))} 時間`, expired: false }
  return { text: `残り約 ${Math.floor(days)} 日`, expired: false }
}

export function TrashPage() {
  const navigate = useNavigate()
  const trashedProjects = useProjectListStore((s) => s.trashedProjects)
  const fetchTrashedProjects = useProjectListStore((s) => s.fetchTrashedProjects)
  const restoreProject = useProjectListStore((s) => s.restoreProject)
  const purgeProject = useProjectListStore((s) => s.purgeProject)

  const trashedFarms = useFarmStore((s) => s.trashedFarms)
  const fetchTrashedFarms = useFarmStore((s) => s.fetchTrashedFarms)
  const restoreFarm = useFarmStore((s) => s.restoreFarm)
  const purgeFarm = useFarmStore((s) => s.purgeFarm)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [farmPurgeProgress, setFarmPurgeProgress] = useState<{
    phase: string
    done?: number
    total?: number
  } | null>(null)

  useEffect(() => {
    void fetchTrashedProjects()
    void fetchTrashedFarms()
  }, [fetchTrashedProjects, fetchTrashedFarms])

  const trashedFarmsSorted = useMemo(
    () =>
      [...trashedFarms].sort(
        (a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''),
      ),
    [trashedFarms],
  )

  const handleRestoreProject = async (id: string) => {
    setBusyId(id)
    try {
      await restoreProject(id)
    } finally {
      setBusyId(null)
    }
  }

  const handlePurgeProject = async (id: string, name: string) => {
    if (
      !confirm(
        `「${name}」を完全に削除します。\n\nこのプロジェクト配下の工区・座標・地番・写真・LandXML など、関連するすべてのデータが失われます。\n\nこの操作は取り消せません。続行しますか？`,
      )
    ) {
      return
    }
    setBusyId(id)
    try {
      await purgeProject(id)
    } finally {
      setBusyId(null)
    }
  }

  const handleRestoreFarm = async (id: string) => {
    setBusyId(id)
    try {
      await restoreFarm(id)
    } finally {
      setBusyId(null)
    }
  }

  const handlePurgeFarm = async (id: string, name: string) => {
    if (
      !confirm(
        `工区「${name}」を完全に削除します。\n\n座標・地番ポリゴン・写真・LandXML・オルソタイルなど関連するすべてのデータと Storage ファイルが削除されます。\n\nこの操作は取り消せません。続行しますか？`,
      )
    ) {
      return
    }
    setBusyId(id)
    try {
      setFarmPurgeProgress({ phase: '関連データを集約中' })
      await purgeFarm(id, (phase, done, total) => {
        setFarmPurgeProgress({ phase, done, total })
      })
    } catch (err) {
      alert(err instanceof Error ? err.message : '完全削除に失敗しました')
    } finally {
      setFarmPurgeProgress(null)
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
            title="戻る"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-lg font-bold text-slate-800">ゴミ箱</h1>
            <div className="text-xs text-slate-500">
              削除から {TRASH_RETENTION_DAYS} 日で自動的に完全削除されます。
              7 日以内なら復元できます。
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-4 space-y-6">
        {/* 削除済み現場 */}
        <section>
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            削除済み現場（プロジェクト）
            <span className="ml-2 text-xs text-slate-400 font-normal">
              {trashedProjects.length} 件
            </span>
          </h2>
          {trashedProjects.length === 0 ? (
            <div className="border rounded-lg bg-white px-4 py-6 text-center text-sm text-slate-400">
              ゴミ箱に現場はありません
            </div>
          ) : (
            <div className="border rounded-lg bg-white divide-y">
              {trashedProjects.map((p) => {
                const days = daysUntilPurge(p.deleted_at)
                const remaining = fmtRemaining(days)
                return (
                  <div key={p.id} className="px-3 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-800 truncate">{p.name}</div>
                      <div className="text-[11px] text-slate-500">
                        削除: {fmtDate(p.deleted_at)}
                        <span
                          className={`ml-2 ${
                            remaining.expired ? 'text-red-600 font-semibold' : 'text-slate-600'
                          }`}
                        >
                          {remaining.text}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => void handleRestoreProject(p.id)}
                      disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border rounded text-emerald-700 border-emerald-300 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      {busyId === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      復元
                    </button>
                    <button
                      onClick={() => void handlePurgeProject(p.id, p.name)}
                      disabled={busyId === p.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border rounded text-red-700 border-red-300 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      完全に削除
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* 削除済み工区 */}
        <section>
          <h2 className="text-sm font-bold text-slate-700 mb-2">
            削除済み工区
            <span className="ml-2 text-xs text-slate-400 font-normal">
              {trashedFarmsSorted.length} 件
            </span>
          </h2>
          {trashedFarmsSorted.length === 0 ? (
            <div className="border rounded-lg bg-white px-4 py-6 text-center text-sm text-slate-400">
              ゴミ箱に工区はありません
            </div>
          ) : (
            <div className="border rounded-lg bg-white divide-y">
              {trashedFarmsSorted.map((f) => {
                const days = daysUntilPurge(f.deleted_at)
                const remaining = fmtRemaining(days)
                return (
                  <div key={f.id} className="px-3 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-800 truncate">{f.name}</div>
                      <div className="text-[11px] text-slate-500">
                        削除: {fmtDate(f.deleted_at)}
                        <span
                          className={`ml-2 ${
                            remaining.expired ? 'text-red-600 font-semibold' : 'text-slate-600'
                          }`}
                        >
                          {remaining.text}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => void handleRestoreFarm(f.id)}
                      disabled={busyId === f.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border rounded text-emerald-700 border-emerald-300 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      {busyId === f.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      復元
                    </button>
                    <button
                      onClick={() => void handlePurgeFarm(f.id, f.name)}
                      disabled={busyId === f.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border rounded text-red-700 border-red-300 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      完全に削除
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <div className="text-[11px] text-slate-400 pt-2 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div>
            「復元」で通常のリストに戻せます。「完全に削除」を押すと、この項目は即時に
            サーバーから削除され、Storage 上の写真・LandXML・オルソタイル等も同時に消えます。
            戻せません。
          </div>
        </div>
      </div>

      {/* 工区の完全削除の進捗 */}
      {farmPurgeProgress && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] p-4">
          <div className="bg-white rounded-lg shadow-xl border w-full max-w-md p-5">
            <div className="flex items-center gap-2 mb-3">
              <Loader2 className="h-5 w-5 animate-spin text-red-600" />
              <div className="text-base font-semibold">工区を完全削除中</div>
            </div>
            <div className="text-sm text-slate-700 mb-2">{farmPurgeProgress.phase}</div>
            {farmPurgeProgress.total != null && farmPurgeProgress.total > 0 && (
              <>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-2xl font-mono font-bold tabular-nums">
                    {(farmPurgeProgress.done ?? 0).toLocaleString()}
                  </span>
                  <span className="text-sm text-slate-500">
                    / {farmPurgeProgress.total.toLocaleString()} 件
                  </span>
                  <span className="ml-auto text-sm text-slate-500">
                    {Math.round(((farmPurgeProgress.done ?? 0) / farmPurgeProgress.total) * 100)}%
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-200 rounded overflow-hidden">
                  <div
                    className="h-full bg-red-600 transition-[width] duration-150"
                    style={{
                      width: `${Math.min(100, ((farmPurgeProgress.done ?? 0) / farmPurgeProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              </>
            )}
            <div className="text-[11px] text-slate-400 mt-3">画面は閉じないでください</div>
          </div>
        </div>
      )}
    </div>
  )
}
