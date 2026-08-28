// カテゴリ詳細画面 (/mobility/projects/:projectId)
//
// - 現場基本情報 + 編集 + 無効化 (active toggle) + 削除
// - メンバー割当 (ドライバー) 一覧 + 追加 (組織メンバーピッカー) + 削除
// - ポイント一覧 + 追加 (地図クリック配置) + 編集 + 削除
// - 地図: 全ポイントをマーカー表示、追加モード時にクリック位置に配置

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  User,
  UserPlus,
  X,
} from 'lucide-react'
import {
  MapContainer,
  TileLayer,
  Marker,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import type { LatLngBoundsExpression } from 'leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type {
  MobilityProject,
  MobilityProjectMember,
  MobilityProjectPoint,
} from '@/types/database'

interface OrgMemberRow {
  user_id: string
  email: string
  full_name: string | null
  role: 'admin' | 'member'
}

// ポイント用マーカーアイコン (Leaflet デフォルト icon の URL 問題を回避)
function pointIcon(highlight: boolean) {
  const color = highlight ? '#dc2626' : '#6366f1'
  return L.divIcon({
    className: 'mobility-point-marker',
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34" style="overflow:visible;">
      <path d="M14 0 C6 0 0 6 0 14 C0 24 14 34 14 34 C14 34 28 24 28 14 C28 6 22 0 14 0 Z"
            fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="13" r="5" fill="white"/>
    </svg>`,
    iconSize: [28, 34],
    iconAnchor: [14, 34],
  })
}

function AutoFit({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length === 0) return
    if (positions.length === 1) {
      map.setView(positions[0], 14, { animate: false })
      return
    }
    const bounds: LatLngBoundsExpression = positions
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: false })
  }, [positions, map])
  return null
}

function MapClickHandler({
  onClick,
  enabled,
}: {
  onClick: (lat: number, lon: number) => void
  enabled: boolean
}) {
  useMapEvents({
    click: (e) => {
      if (!enabled) return
      onClick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

export function MobilityProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const canManage = useCanManageMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const {
    fetchProjects,
    updateProject,
    deleteProject,
    fetchProjectMembers,
    addProjectMember,
    removeProjectMember,
    fetchProjectPoints,
    createPoint,
    updatePoint,
    deletePoint,
  } = useMobilityStore()

  const [project, setProject] = useState<MobilityProject | null>(null)
  const [members, setMembers] = useState<MobilityProjectMember[]>([])
  const [points, setPoints] = useState<MobilityProjectPoint[]>([])
  const [orgMembers, setOrgMembers] = useState<OrgMemberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [addPointMode, setAddPointMode] = useState(false)
  const [editingPoint, setEditingPoint] = useState<MobilityProjectPoint | null>(null)
  const [showEditProject, setShowEditProject] = useState(false)
  const [showMemberPicker, setShowMemberPicker] = useState(false)

  const refresh = useCallback(async () => {
    if (!orgId || !projectId) return
    setLoading(true)
    try {
      const [projects, ms, pts, orgList] = await Promise.all([
        fetchProjects(orgId),
        fetchProjectMembers(projectId),
        fetchProjectPoints(projectId),
        (async () => {
          const { data } = (await supabase.rpc(
            'list_org_members' as never,
            { p_org_id: orgId } as never,
          )) as unknown as { data: OrgMemberRow[] | null; error: unknown }
          return data ?? []
        })(),
      ])
      setProject(projects.find((p) => p.id === projectId) ?? null)
      setMembers(ms)
      setPoints(pts)
      setOrgMembers(orgList)
    } finally {
      setLoading(false)
    }
  }, [
    orgId,
    projectId,
    fetchProjects,
    fetchProjectMembers,
    fetchProjectPoints,
  ])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mapPoints = useMemo(
    () => points.map((p) => [p.lat, p.lon] as [number, number]),
    [points],
  )

  const assignedIds = useMemo(
    () => new Set(members.map((m) => m.user_id)),
    [members],
  )
  const availableToAdd = useMemo(
    () => orgMembers.filter((m) => !assignedIds.has(m.user_id)),
    [orgMembers, assignedIds],
  )
  const memberNameMap = useMemo(() => {
    const m = new Map<string, OrgMemberRow>()
    for (const r of orgMembers) m.set(r.user_id, r)
    return m
  }, [orgMembers])

  if (!canManage) return <Navigate to="/mobility/drive" replace />
  if (!projectId) return <Navigate to="/mobility/projects" replace />

  const handleAddPointFromMap = async (lat: number, lon: number) => {
    setAddPointMode(false)
    const name = window.prompt('ポイント名 (例: 土取場, 現場A)')
    if (!name || !name.trim()) return
    const kind = window.prompt('種別 (例: 土取場, 採石場, 雪捨場, 農場A)  ※任意') || null
    const created = await createPoint({
      project_id: projectId,
      name: name.trim(),
      kind,
      lat,
      lon,
      display_order: points.length,
    })
    if (created) setPoints((prev) => [...prev, created])
  }

  const handleDeletePoint = async (id: string) => {
    if (!confirm('このポイントを削除しますか?')) return
    await deletePoint(id)
    setPoints((prev) => prev.filter((p) => p.id !== id))
  }

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-3 bg-white border-b flex items-center gap-2 shrink-0">
        <button
          onClick={() => navigate('/mobility/projects')}
          className="p-1 rounded hover:bg-slate-100 text-slate-500"
          title="カテゴリ一覧に戻る"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <MapPin className="h-5 w-5 text-indigo-600" />
        <h1 className="text-base font-bold truncate flex-1">
          {project?.name ?? '(読み込み中)'}
        </h1>
        {project && (
          <>
            <button
              type="button"
              onClick={() => setShowEditProject(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
            >
              <Pencil className="h-3 w-3" /> 現場編集
            </button>
          </>
        )}
      </div>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* 地図 */}
        <div className="h-72 lg:h-auto lg:flex-1 relative border-b lg:border-b-0 lg:border-r">
          {addPointMode && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-indigo-600 text-white text-xs rounded-full px-3 py-1 shadow flex items-center gap-2">
              <span>地図をクリックしてポイントを配置</span>
              <button
                type="button"
                onClick={() => setAddPointMode(false)}
                className="text-white/80 hover:text-white"
              >
                取消
              </button>
            </div>
          )}
          {loading && (
            <div className="absolute top-3 right-3 z-[1000] bg-white/95 rounded border px-2 py-1 text-xs shadow flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> 読み込み中...
            </div>
          )}
          <MapContainer
            center={[35.681236, 139.767125]}
            zoom={12}
            className="h-full w-full"
            style={addPointMode ? { cursor: 'crosshair' } : undefined}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <AutoFit positions={mapPoints} />
            <MapClickHandler enabled={addPointMode} onClick={handleAddPointFromMap} />
            {points.map((p) => (
              <Marker
                key={p.id}
                position={[p.lat, p.lon]}
                icon={pointIcon(editingPoint?.id === p.id)}
                eventHandlers={{
                  click: () => setEditingPoint(p),
                }}
              >
                <Tooltip direction="top" offset={[0, -30]} permanent>
                  <span className="text-xs font-medium">
                    {p.name}
                    {p.kind && (
                      <span className="text-slate-500 ml-1">({p.kind})</span>
                    )}
                  </span>
                </Tooltip>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {/* サイドパネル */}
        <div className="lg:w-96 xl:w-[28rem] overflow-y-auto p-4 space-y-5">
          {/* 現場情報 */}
          <div className="p-3 bg-white rounded-lg border">
            <div className="text-[10px] text-slate-500 mb-1">現場情報</div>
            <div className="text-sm font-medium">{project?.name ?? '—'}</div>
            {project?.description && (
              <div className="text-xs text-slate-600 mt-1 whitespace-pre-wrap">
                {project.description}
              </div>
            )}
            {project && !project.active && (
              <div className="text-[10px] text-slate-500 mt-1">無効化済み</div>
            )}
          </div>

          {/* メンバー (ドライバー) */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-5 rounded bg-emerald-500" />
              <h2 className="text-sm font-semibold text-slate-700 flex-1">
                ドライバー ({members.length})
              </h2>
              <button
                type="button"
                onClick={() => setShowMemberPicker(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700"
              >
                <UserPlus className="h-3 w-3" />
                追加
              </button>
            </div>
            {members.length === 0 ? (
              <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                ドライバー未割当。「追加」から選択してください。
              </div>
            ) : (
              <ul className="space-y-1">
                {members.map((m) => {
                  const om = memberNameMap.get(m.user_id)
                  return (
                    <li
                      key={m.user_id}
                      className="flex items-center gap-2 p-2 bg-white rounded border text-xs"
                    >
                      <User className="h-3 w-3 text-slate-400 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">
                        {om?.full_name || om?.email || m.user_id.slice(0, 8)}
                      </span>
                      {om?.role === 'admin' && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">
                          管理者
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm('このドライバーを外しますか?')) return
                          await removeProjectMember(projectId, m.user_id)
                          setMembers((prev) =>
                            prev.filter((x) => x.user_id !== m.user_id),
                          )
                        }}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                        title="削除"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* ポイント */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1 h-5 rounded bg-indigo-500" />
              <h2 className="text-sm font-semibold text-slate-700 flex-1">
                ポイント ({points.length})
              </h2>
              <button
                type="button"
                onClick={() => setAddPointMode(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
              >
                <Plus className="h-3 w-3" />
                地図から追加
              </button>
            </div>
            {points.length === 0 ? (
              <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
                ポイント未登録。「地図から追加」で地図をクリックしてください。
              </div>
            ) : (
              <ul className="space-y-1">
                {points.map((p) => (
                  <li
                    key={p.id}
                    className={`flex items-center gap-2 p-2 bg-white rounded border text-xs ${
                      editingPoint?.id === p.id ? 'ring-1 ring-indigo-500' : ''
                    }`}
                  >
                    <MapPin className="h-3 w-3 text-indigo-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {p.name}
                        {p.kind && (
                          <span className="text-slate-400 ml-1">({p.kind})</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingPoint(p)}
                      className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                      title="編集"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeletePoint(p.id)}
                      className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* 現場編集ダイアログ */}
      {showEditProject && project && (
        <ProjectEditDialog
          project={project}
          onSave={async (patch) => {
            await updateProject(project.id, patch)
            setProject((prev) => (prev ? { ...prev, ...patch } : prev))
            setShowEditProject(false)
          }}
          onDelete={async () => {
            if (
              !confirm(
                `カテゴリ「${project.name}」を完全削除しますか?\nメンバー割当・ポイント・履歴も連鎖削除されます。`,
              )
            )
              return
            await deleteProject(project.id)
            navigate('/mobility/projects')
          }}
          onClose={() => setShowEditProject(false)}
        />
      )}

      {/* ポイント編集ダイアログ */}
      {editingPoint && (
        <PointEditDialog
          point={editingPoint}
          onSave={async (patch) => {
            await updatePoint(editingPoint.id, patch)
            setPoints((prev) =>
              prev.map((p) =>
                p.id === editingPoint.id ? { ...p, ...patch } : p,
              ),
            )
            setEditingPoint(null)
          }}
          onClose={() => setEditingPoint(null)}
        />
      )}

      {/* メンバー追加ダイアログ */}
      {showMemberPicker && (
        <MemberPickerDialog
          candidates={availableToAdd}
          onPick={async (userId) => {
            await addProjectMember(projectId, userId)
            setShowMemberPicker(false)
            await refresh()
          }}
          onClose={() => setShowMemberPicker(false)}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------
// ダイアログ群
// ------------------------------------------------------------

function ProjectEditDialog({
  project,
  onSave,
  onDelete,
  onClose,
}: {
  project: MobilityProject
  onSave: (patch: {
    name: string
    description: string | null
    active: boolean
  }) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [active, setActive] = useState(project.active)
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
          <h3 className="text-base font-semibold">カテゴリを編集</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">現場名</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded h-16"
            />
          </div>
          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span className="text-xs">有効な現場</span>
          </label>
          <div className="pt-2 border-t">
            <button
              type="button"
              onClick={async () => {
                setBusy(true)
                try {
                  await onDelete()
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4" />
              完全削除
            </button>
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
              await onSave({
                name: name.trim(),
                description: description.trim() || null,
                active,
              })
              setBusy(false)
            }}
            disabled={!name.trim() || busy}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function PointEditDialog({
  point,
  onSave,
  onClose,
}: {
  point: MobilityProjectPoint
  onSave: (patch: {
    name: string
    kind: string | null
    memo: string | null
  }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(point.name)
  const [kind, setKind] = useState(point.kind ?? '')
  const [memo, setMemo] = useState(point.memo ?? '')
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
          <h3 className="text-base font-semibold">ポイントを編集</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">名前</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              種別 (例: 土取場, 採石場, 雪捨場, 農場A)
            </label>
            <input
              type="text"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">メモ</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded h-16"
            />
          </div>
          <div className="text-[10px] text-slate-500 font-mono">
            座標: {point.lat.toFixed(6)}, {point.lon.toFixed(6)}
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
              await onSave({
                name: name.trim(),
                kind: kind.trim() || null,
                memo: memo.trim() || null,
              })
              setBusy(false)
            }}
            disabled={!name.trim() || busy}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function MemberPickerDialog({
  candidates,
  onPick,
  onClose,
}: {
  candidates: OrgMemberRow[]
  onPick: (userId: string) => Promise<void>
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">ドライバーを追加</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-2 overflow-y-auto flex-1">
          {candidates.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400">
              追加可能なメンバーがいません (全員既に割当済み)
            </div>
          ) : (
            <ul className="divide-y">
              {candidates.map((m) => (
                <li key={m.user_id}>
                  <button
                    type="button"
                    onClick={() => void onPick(m.user_id)}
                    className="w-full flex items-center gap-2 p-3 text-left hover:bg-indigo-50"
                  >
                    <User className="h-4 w-4 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {m.full_name || m.email}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {m.email}
                      </div>
                    </div>
                    {m.role === 'admin' && (
                      <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">
                        管理者
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
