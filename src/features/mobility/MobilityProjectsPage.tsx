// カテゴリ一覧画面 (/mobility/projects)
//
// - 組織 admin 向け。現場マスタの一覧・作成・編集・削除。
// - 各行にメンバー数とポイント数を表示 (別途 fetch)。
// - 行クリック or 「詳細」で /mobility/projects/:id へ。

import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowLeft, Folder, Loader2, MapPin, Plus, User, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type { MobilityProject } from '@/types/database'

export function MobilityProjectsPage() {
  const navigate = useNavigate()
  const canManage = useCanManageMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const { fetchProjects, createProject } = useMobilityStore()

  const [projects, setProjects] = useState<MobilityProject[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const refresh = async () => {
    if (!orgId) return
    setLoading(true)
    try {
      const rows = await fetchProjects(orgId)
      setProjects(rows)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  if (!canManage) return <Navigate to="/mobility/drive" replace />
  if (!orgId) return <Navigate to="/mobility" replace />

  const active = projects.filter((p) => p.active)
  const inactive = projects.filter((p) => !p.active)

  return (
    <div className="h-full flex flex-col bg-slate-50 overflow-auto">
      <div className="p-4 bg-white border-b flex items-center gap-3 shrink-0">
        <button
          onClick={() => navigate('/mobility')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="モビリティトップに戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Folder className="h-5 w-5 text-indigo-600" />
        <h1 className="text-lg font-bold flex-1">カテゴリ</h1>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          新規カテゴリ
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading && projects.length === 0 ? (
          <div className="p-4 text-center text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            読み込み中...
          </div>
        ) : projects.length === 0 ? (
          <div className="p-6 bg-white rounded border text-center text-sm text-slate-500">
            カテゴリがありません。右上の「新規カテゴリ」から作成してください。
          </div>
        ) : (
          <>
            <ProjectList
              projects={active}
              onOpen={(id) => navigate(`/mobility/projects/${id}`)}
            />
            {inactive.length > 0 && (
              <>
                <div className="flex items-center gap-2 mt-4 mb-2">
                  <div className="w-1 h-5 rounded bg-slate-400" />
                  <h3 className="text-xs font-medium text-slate-500">
                    無効化済み ({inactive.length})
                  </h3>
                </div>
                <ProjectList
                  projects={inactive}
                  onOpen={(id) => navigate(`/mobility/projects/${id}`)}
                  faded
                />
              </>
            )}
          </>
        )}
      </div>

      {showNew && (
        <NewProjectDialog
          onCreate={async ({ name, description }) => {
            const p = await createProject({
              organization_id: orgId,
              name,
              description,
            })
            setShowNew(false)
            if (p) navigate(`/mobility/projects/${p.id}`)
            else await refresh()
          }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  )
}

function ProjectList({
  projects,
  onOpen,
  faded,
}: {
  projects: MobilityProject[]
  onOpen: (id: string) => void
  faded?: boolean
}) {
  return (
    <ul className={`space-y-2 ${faded ? 'opacity-60' : ''}`}>
      {projects.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onOpen(p.id)}
            className="w-full flex items-center gap-3 p-3 bg-white rounded-lg border hover:border-indigo-400 text-left"
          >
            <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <Folder className="h-4 w-4 text-indigo-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800 truncate">
                {p.name}
              </div>
              {p.description && (
                <div className="text-[11px] text-slate-500 truncate mt-0.5">
                  {p.description}
                </div>
              )}
            </div>
            {/* メンバー/ポイント数は詳細画面で確認 (件数取得は API 追加コスト) */}
            <div className="shrink-0 flex items-center gap-2 text-[11px] text-slate-400">
              <User className="h-3 w-3" />
              <span>ドライバー</span>
              <MapPin className="h-3 w-3 ml-1" />
              <span>ポイント</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function NewProjectDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: { name: string; description: string | null }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">新規カテゴリ</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              現場名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: A地区運搬"
              autoFocus
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">説明 (任意)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 text-sm border rounded h-16"
            />
          </div>
        </div>
        <div className="px-4 py-3 border-t flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={async () => {
              if (!name.trim() || busy) return
              setBusy(true)
              await onCreate({
                name: name.trim(),
                description: description.trim() || null,
              })
              setBusy(false)
            }}
            disabled={!name.trim() || busy}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            作成
          </button>
        </div>
      </div>
    </div>
  )
}
