// モビリティ機能のホーム画面。
//
// 構成:
//   ・ヘッダ (戻るボタン、タイトル、開発中バッジ)
//   ・稼働中の車両サマリ (assignment.ended_at IS NULL の一覧)
//   ・車両マスタ一覧 (新規/編集/廃止/削除)
//
// 権限:
//   ・useCanManageMobility() で org admin + site owner のみ通す
//   ・組織 admin のみ車両編集 (RLS 側でも二重ガードなので UI 判定は
//     楽観的に「所属組織があれば触れる」形で始めて、失敗時にサーバから戻す)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar,
  Car,
  ChevronDown,
  Construction,
  Folder,
  Loader2,
  LogOut,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Truck,
  User,
  UserPlus,
  X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import {
  useMobilityStore,
  type AssignmentWithNames,
} from '@/stores/mobilityStore'
import type {
  MobilityPosition,
  MobilityProject,
  MobilityProjectMember,
  MobilityProjectPoint,
  Vehicle,
  VehicleKind,
} from '@/types/database'
import { FleetMapView, formatAgeShort } from '@/features/mobility/FleetMapView'
import { computeTotalDistanceMeters } from '@/lib/geoDistance'
import { supabase } from '@/lib/supabase'

// 電話番号 + SMS 招待 UI の表示フラグ。
//   下地 (DB migration / Edge Function / ダイアログ) は push 済みだが、
//   SMS プロバイダ (Twilio) が未設定なので UI からは一時的に隠している。
//   復活させるには true にして、SQL migration 20260731 適用 +
//   supabase functions deploy invite-member + Twilio 設定を済ませる。
const PHONE_INVITE_ENABLED = false

/** 日本の電話番号を E.164 (+81 xx xxxx xxxx) に正規化。無効なら null。 */
function normalizeJpPhone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const isIntl = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (isIntl) {
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }
  if (digits.length >= 10 && digits.length <= 11 && digits.startsWith('0')) {
    return `+81${digits.substring(1)}`
  }
  if (digits.startsWith('81') && digits.length >= 11 && digits.length <= 13) {
    return `+${digits}`
  }
  return null
}

interface OrgMemberRow {
  user_id: string
  email: string
  full_name: string | null
  phone: string | null
  role: 'admin' | 'member'
  joined_at: string
  invited_by: string | null
  last_sign_in_at: string | null
}

const KIND_LABEL: Record<VehicleKind, string> = {
  car: '普通車',
  truck: 'トラック',
  heavy_equipment: '重機',
  other: 'その他',
}

const KIND_ICON: Record<VehicleKind, typeof Car> = {
  car: Car,
  truck: Truck,
  heavy_equipment: Construction,
  other: Car,
}

export function MobilityHomePage() {
  const navigate = useNavigate()
  const canUse = useCanManageMobility()
  const { profile } = useAuth()
  const orgId = profile?.organization_id ?? null

  const {
    vehicles,
    vehiclesLoading,
    vehiclesError,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    createVehicle,
    updateVehicle,
    deleteVehicle,
    endAssignment,
    deleteAssignment,
    latestPositionsByAssignment,
    fetchProjects,
    createProject,
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

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  // 既定は ドライバー (ユーザー) タブ
  const [mode, setMode] = useState<'vehicle' | 'user'>('user')
  const [orgMembers, setOrgMembers] = useState<OrgMemberRow[]>([])
  const [orgMembersLoading, setOrgMembersLoading] = useState(false)
  const [showPhoneInvite, setShowPhoneInvite] = useState(false)

  // 運行現場 (左パネル) の state
  const [projects, setProjects] = useState<MobilityProject[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [expandedProjectPoints, setExpandedProjectPoints] = useState<
    MobilityProjectPoint[]
  >([])
  const [expandedProjectMembers, setExpandedProjectMembers] = useState<
    MobilityProjectMember[]
  >([])
  const [addPointMode, setAddPointMode] = useState(false)
  const [editingPoint, setEditingPoint] = useState<MobilityProjectPoint | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showEditProjectId, setShowEditProjectId] = useState<string | null>(null)
  const [showMemberPickerForProject, setShowMemberPickerForProject] = useState<
    string | null
  >(null)

  // インライン展開する行 (同時に 1 台/1 人のみ)
  const [expandedVehicleId, setExpandedVehicleId] = useState<string | null>(null)
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)
  // 運行履歴で選択中の「セクション」(1 回の乗車 = 1 assignment)。単選択。
  // 選択されている間、その assignment の軌跡だけが地図に表示される。
  const [selectedSectionAssignmentId, setSelectedSectionAssignmentId] =
    useState<string | null>(null)

  const selectSection = useCallback((assignmentId: string) => {
    setSelectedSectionAssignmentId((prev) =>
      prev === assignmentId ? null : assignmentId,
    )
  }, [])

  // FleetMapView は複数対応 (extraTrackAssignmentIds[]) のままなので、
  // 0 or 1 要素の配列に包んで渡す
  const selectedSectionIdArr = useMemo(
    () => (selectedSectionAssignmentId ? [selectedSectionAssignmentId] : []),
    [selectedSectionAssignmentId],
  )

  const toggleExpandVehicle = useCallback((vehicleId: string) => {
    setExpandedVehicleId((prev) => (prev === vehicleId ? null : vehicleId))
    setExpandedUserId(null)
    setSelectedSectionAssignmentId(null)
  }, [])

  // 追跡対象の assignment id を導出:
  //   - 車両モードで expandedVehicleId が指す active assignment
  //   - ユーザーモードで expandedUserId が指す active assignment
  //   - どちらも該当なしなら null (=追跡しない)
  const followAssignmentId = useMemo<string | null>(() => {
    if (expandedVehicleId) {
      return activeAssignments.get(expandedVehicleId)?.id ?? null
    }
    if (expandedUserId) {
      const a = Array.from(activeAssignments.values()).find(
        (x) => x.user_id === expandedUserId,
      )
      return a?.id ?? null
    }
    return null
  }, [expandedVehicleId, expandedUserId, activeAssignments])

  // 通信断バッジの再描画用 tick + しきい値
  const [staleTick, setStaleTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setStaleTick(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])
  const STALE_THRESHOLD_MS = 60_000
  const ageMsForAssignment = useCallback(
    (assignmentId: string): number | null => {
      const p = latestPositionsByAssignment.get(assignmentId)
      if (!p) return null
      return staleTick - new Date(p.recorded_at).getTime()
    },
    [latestPositionsByAssignment, staleTick],
  )

  const toggleExpandUser = useCallback((userId: string) => {
    setExpandedUserId((prev) => (prev === userId ? null : userId))
    setExpandedVehicleId(null)
    setSelectedSectionAssignmentId(null)
  }, [])

  // ユーザー一覧を取得。運行現場のメンバー割当ダイアログでも使うので mode 問わず取得。
  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    setOrgMembersLoading(true)
    ;(async () => {
      const { data } = (await supabase.rpc(
        'list_org_members' as never,
        { p_org_id: orgId } as never,
      )) as unknown as { data: OrgMemberRow[] | null; error: unknown }
      if (!cancelled) {
        setOrgMembers(data ?? [])
        setOrgMembersLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [orgId])

  // 運行現場一覧を取得
  const refreshProjects = useCallback(async () => {
    if (!orgId) return
    setProjectsLoading(true)
    try {
      const rows = await fetchProjects(orgId)
      setProjects(rows)
    } finally {
      setProjectsLoading(false)
    }
  }, [orgId, fetchProjects])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // 展開中の現場のメンバー + ポイントを取得
  useEffect(() => {
    if (!expandedProjectId) {
      setExpandedProjectPoints([])
      setExpandedProjectMembers([])
      setAddPointMode(false)
      return
    }
    let cancelled = false
    void (async () => {
      const [pts, mems] = await Promise.all([
        fetchProjectPoints(expandedProjectId),
        fetchProjectMembers(expandedProjectId),
      ])
      if (!cancelled) {
        setExpandedProjectPoints(pts)
        setExpandedProjectMembers(mems)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [expandedProjectId, fetchProjectPoints, fetchProjectMembers])

  const toggleExpandProject = useCallback((id: string) => {
    setExpandedProjectId((prev) => (prev === id ? null : id))
  }, [])

  // 地図クリックで新規ポイント配置
  // 新規ポイントの一時座標。地図クリックで捕捉 → ダイアログで名前+備考を入力 → 保存
  const [pendingNewPoint, setPendingNewPoint] = useState<{
    lat: number
    lon: number
  } | null>(null)
  const handleMapClickForNewPoint = useCallback(
    (lat: number, lon: number) => {
      if (!expandedProjectId) return
      setAddPointMode(false)
      setPendingNewPoint({ lat, lon })
    },
    [expandedProjectId],
  )

  // 管理者による強制降車。ドライバー端末で降車されていない稼働中割当を admin 権限で終了する。
  // RLS: vehicle_assignments_update ポリシーで is_org_admin_of_vehicle が許可済み。
  const [forceLeaveBusyId, setForceLeaveBusyId] = useState<string | null>(null)
  const handleForceLeave = useCallback(
    async (
      assignmentId: string,
      driverName: string | null,
      vehicleName: string,
    ) => {
      if (
        !confirm(
          `${driverName || '(名前未設定)'} が乗車中の車両「${vehicleName}」を、\n管理者権限で降車させますか?\n\nドライバー端末での自動送信もあわせて停止させたい場合は、\nドライバー本人にも通知してください。`,
        )
      )
        return
      setForceLeaveBusyId(assignmentId)
      try {
        await endAssignment(assignmentId)
        if (orgId) await fetchActiveAssignments(orgId)
      } finally {
        setForceLeaveBusyId(null)
      }
    },
    [endAssignment, fetchActiveAssignments, orgId],
  )

  // セクション削除。位置ログも CASCADE 削除される。
  // 削除後は活動割当一覧を refetch し、選択中セクションと展開状態を初期化。
  // 展開中の InlineDetailBody に「履歴を再取得しろ」と伝えるための tick。
  const [sectionHistoryTick, setSectionHistoryTick] = useState(0)
  const handleDeleteSection = useCallback(
    async (
      assignmentId: string,
      label: string,
    ) => {
      if (
        !confirm(
          `セクション「${label}」を完全に削除しますか?\n\nこのセクション中に記録された位置情報 (GPS ping) もすべて消えます。この操作は元に戻せません。`,
        )
      )
        return
      const res = await deleteAssignment(assignmentId)
      if (!res.ok) {
        alert(`削除に失敗しました: ${res.error}`)
        return
      }
      if (selectedSectionAssignmentId === assignmentId) {
        setSelectedSectionAssignmentId(null)
      }
      if (orgId) await fetchActiveAssignments(orgId)
      setSectionHistoryTick((n) => n + 1)
    },
    [
      deleteAssignment,
      selectedSectionAssignmentId,
      fetchActiveAssignments,
      orgId,
    ],
  )

  const activeVehicles = useMemo(
    () => vehicles.filter((v) => v.active),
    [vehicles],
  )
  const inactiveVehicles = useMemo(
    () => vehicles.filter((v) => !v.active),
    [vehicles],
  )

  if (!canUse) return <Navigate to="/" replace />

  if (!orgId) {
    return (
      <div className="h-full flex flex-col bg-slate-50">
        <MobilityHeader onBack={() => navigate('/')} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-xl border shadow-sm p-8 text-center">
            <p className="text-sm text-slate-600">
              モビリティ機能を利用するには組織に所属している必要があります。
              サイトオーナーであっても、組織 admin として登録された組織を選ぶ必要があります。
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-slate-50">
      <MobilityHeader
        onBack={() => navigate('/')}
        onOpenLogs={() => navigate('/mobility/logs')}
      />

      {vehiclesError && (
        <div className="mx-4 mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {vehiclesError}
        </div>
      )}

      {/* PC は 左: 運行現場 | 中央: 地図 | 右: ドライバー/車両。狭い画面は縦積み */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* 左サイドパネル: 運行現場 (現場 > ポイント / メンバー) */}
        <div className="lg:w-80 xl:w-96 overflow-y-auto p-4 space-y-3 border-b lg:border-b-0 lg:border-r bg-slate-50">
          <ProjectsLeftPanel
            projects={projects}
            projectsLoading={projectsLoading}
            expandedProjectId={expandedProjectId}
            expandedProjectMembers={expandedProjectMembers}
            expandedProjectPoints={expandedProjectPoints}
            orgMembers={orgMembers}
            addPointMode={addPointMode}
            onToggleExpand={toggleExpandProject}
            onNewProject={() => setShowNewProjectDialog(true)}
            onEditProject={setShowEditProjectId}
            onOpenMemberPicker={setShowMemberPickerForProject}
            onRemoveMember={async (projectId, userId) => {
              if (!confirm('このドライバーを外しますか?')) return
              await removeProjectMember(projectId, userId)
              setExpandedProjectMembers((prev) =>
                prev.filter((m) => m.user_id !== userId),
              )
            }}
            onEnterAddPointMode={() => setAddPointMode(true)}
            onCancelAddPointMode={() => setAddPointMode(false)}
            onEditPoint={setEditingPoint}
            onDeletePoint={async (pointId) => {
              if (!confirm('このポイントを削除しますか?')) return
              await deletePoint(pointId)
              setExpandedProjectPoints((prev) =>
                prev.filter((p) => p.id !== pointId),
              )
            }}
          />
        </div>

        {/* 地図エリア */}
        <div className="h-64 lg:h-auto lg:flex-1 relative border-b lg:border-b-0 lg:border-r">
          <FleetMapView
            organizationId={orgId}
            extraTrackAssignmentIds={selectedSectionIdArr}
            projectPoints={expandedProjectPoints}
            highlightPointId={editingPoint?.id ?? null}
            addPointMode={addPointMode}
            followAssignmentId={followAssignmentId}
            onMapClick={handleMapClickForNewPoint}
            onSelectPoint={(pid) => {
              const pt = expandedProjectPoints.find((p) => p.id === pid) ?? null
              setEditingPoint(pt)
            }}
            onSelectVehicle={(vid) => {
              // 別画面に飛ばさず、右パネルの該当行を展開する
              setMode('vehicle')
              setExpandedVehicleId(vid)
              setExpandedUserId(null)
            }}
          />
        </div>

        {/* 右サイドパネル: 稼働中 + 車両マスタ */}
        <div className="lg:w-96 xl:w-[28rem] overflow-y-auto p-4 space-y-5">
        {/* モード切替タブ */}
        <div className="flex gap-1 p-1 bg-slate-200 rounded">
          <button
            type="button"
            onClick={() => setMode('vehicle')}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded ${
              mode === 'vehicle'
                ? 'bg-white text-indigo-700 shadow'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <Car className="h-3.5 w-3.5" />
            車両単位
          </button>
          <button
            type="button"
            onClick={() => setMode('user')}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded ${
              mode === 'user'
                ? 'bg-white text-indigo-700 shadow'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <User className="h-3.5 w-3.5" />
            ユーザー単位
          </button>
        </div>

        {mode === 'user' && (
          <UserModeSidebar
            activeAssignments={activeAssignments}
            vehicles={vehicles}
            orgMembers={orgMembers}
            loading={orgMembersLoading}
            expandedUserId={expandedUserId}
            selectedId={selectedSectionAssignmentId}
            forceLeaveBusyId={forceLeaveBusyId}
            ageMsForAssignment={ageMsForAssignment}
            staleThresholdMs={STALE_THRESHOLD_MS}
            onToggleExpand={toggleExpandUser}
            onSelect={selectSection}
            onDeleteSection={handleDeleteSection}
            historyReloadKey={sectionHistoryTick}
            onForceLeave={handleForceLeave}
            onInviteByPhone={() => setShowPhoneInvite(true)}
          />
        )}

        {mode === 'vehicle' && (
          <>
        {/* 稼働中サマリ */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-5 rounded bg-emerald-500" />
            <h2 className="text-sm font-semibold text-slate-700">
              稼働中 ({activeAssignments.size} / {activeVehicles.length})
            </h2>
          </div>
          {activeAssignments.size === 0 ? (
            <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
              現在稼働中の車両はありません
            </div>
          ) : (
            <ul className="space-y-1.5">
              {Array.from(activeAssignments.entries()).map(([vehicleId, a]) => {
                const v = vehicles.find((x) => x.id === vehicleId)
                if (!v) return null
                const Icon = KIND_ICON[v.kind]
                const expanded = expandedVehicleId === v.id
                return (
                  <li
                    key={a.id}
                    className={`bg-white rounded border ${
                      expanded ? 'ring-1 ring-indigo-500 border-indigo-400' : 'hover:border-indigo-400'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpandVehicle(v.id)}
                      className="w-full flex items-center gap-3 p-3 text-left"
                    >
                      <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                        <Icon className="h-4 w-4 text-emerald-700" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800 truncate">
                          {v.name}
                          {v.plate_or_serial && (
                            <span className="text-slate-400 text-xs ml-1.5">
                              ({v.plate_or_serial})
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
                          <User className="h-3 w-3" />
                          {a.driver_name || '(名前未設定)'}
                          <span className="mx-1">·</span>
                          {new Date(a.started_at).toLocaleString('ja-JP', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          〜
                        </div>
                        {a.destination_point && (
                          <div className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5 truncate">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              行き先: {a.destination_point.name}
                            </span>
                          </div>
                        )}
                      </div>
                      {(() => {
                        const age = ageMsForAssignment(a.id)
                        if (age != null && age > STALE_THRESHOLD_MS) {
                          return (
                            <span
                              className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 border border-red-300"
                              title={`最終 ping から ${formatAgeShort(age)}`}
                            >
                              ⚠ 通信断 {formatAgeShort(age)}
                            </span>
                          )
                        }
                        return (
                          <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                            稼働中
                          </span>
                        )
                      })()}
                      <ChevronDown
                        className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
                          expanded ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {/* 管理者による強制降車 (ドライバー端末で降車忘れの救済) */}
                    <div className="px-3 pb-2 flex justify-end">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleForceLeave(
                            a.id,
                            a.driver_name,
                            v.name,
                          )
                        }}
                        disabled={forceLeaveBusyId === a.id}
                        className="flex items-center gap-1 px-2 py-0.5 text-[10px] border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                        title="管理者権限で降車させる"
                      >
                        {forceLeaveBusyId === a.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <LogOut className="h-3 w-3" />
                        )}
                        強制降車
                      </button>
                    </div>
                    {expanded && (
                      <VehicleInlineDetail
                        vehicleId={v.id}
                        activeAssignment={a}
                        selectedId={selectedSectionAssignmentId}
                        onSelect={selectSection}
                        onDeleteSection={handleDeleteSection}
                        historyReloadKey={sectionHistoryTick}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* 車両マスタ */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1 h-5 rounded bg-indigo-500" />
            <h2 className="text-sm font-semibold text-slate-700 flex-1">車両マスタ</h2>
            <button
              type="button"
              onClick={() => setShowNewDialog(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              <Plus className="h-3 w-3" />
              新規車両
            </button>
          </div>

          {vehiclesLoading && vehicles.length === 0 ? (
            <div className="p-4 text-center text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
              読み込み中...
            </div>
          ) : activeVehicles.length === 0 && inactiveVehicles.length === 0 ? (
            <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
              車両が登録されていません。「新規車両」から追加してください
            </div>
          ) : (
            <>
              <ul className="space-y-1.5">
                {activeVehicles.map((v) => (
                  <VehicleRow
                    key={v.id}
                    vehicle={v}
                    active={activeAssignments.has(v.id)}
                    activeAssignment={activeAssignments.get(v.id) ?? null}
                    expanded={expandedVehicleId === v.id}
                    selectedId={selectedSectionAssignmentId}
                    onToggleExpand={() => toggleExpandVehicle(v.id)}
                    onSelect={selectSection}
                    onDeleteSection={handleDeleteSection}
                    historyReloadKey={sectionHistoryTick}
                    onEdit={() => setEditingVehicle(v)}
                  />
                ))}
              </ul>
              {inactiveVehicles.length > 0 && (
                <>
                  <div className="flex items-center gap-2 mt-4 mb-2">
                    <div className="w-1 h-5 rounded bg-slate-400" />
                    <h3 className="text-xs font-medium text-slate-500">
                      廃止済み ({inactiveVehicles.length})
                    </h3>
                  </div>
                  <ul className="space-y-1.5 opacity-60">
                    {inactiveVehicles.map((v) => (
                      <VehicleRow
                        key={v.id}
                        vehicle={v}
                        active={false}
                        activeAssignment={null}
                        expanded={expandedVehicleId === v.id}
                        selectedId={selectedSectionAssignmentId}
                        onToggleExpand={() => toggleExpandVehicle(v.id)}
                        onSelect={selectSection}
                        onEdit={() => setEditingVehicle(v)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
          </>
        )}
        </div>
      </div>

      {showNewDialog && (
        <VehicleEditDialog
          mode="create"
          organizationId={orgId}
          onSave={async (input) => {
            await createVehicle({
              organization_id: orgId,
              name: input.name,
              plate_or_serial: input.plate_or_serial,
              kind: input.kind,
              memo: input.memo,
            })
            setShowNewDialog(false)
          }}
          onClose={() => setShowNewDialog(false)}
        />
      )}
      {editingVehicle && (
        <VehicleEditDialog
          mode="edit"
          organizationId={orgId}
          initial={editingVehicle}
          onSave={async (input) => {
            await updateVehicle(editingVehicle.id, {
              name: input.name,
              plate_or_serial: input.plate_or_serial,
              kind: input.kind,
              memo: input.memo,
              active: input.active,
            })
            setEditingVehicle(null)
          }}
          onDelete={async () => {
            if (
              confirm(
                `車両「${editingVehicle.name}」を完全削除しますか?\n過去の割当と GPS ログも連鎖削除されます。`,
              )
            ) {
              await deleteVehicle(editingVehicle.id)
              setEditingVehicle(null)
            }
          }}
          onClose={() => setEditingVehicle(null)}
        />
      )}
      {showPhoneInvite && (
        <PhoneInviteDialog
          organizationId={orgId}
          onClose={() => setShowPhoneInvite(false)}
        />
      )}

      {/* 運行現場 関連ダイアログ */}
      {showNewProjectDialog && (
        <ProjectCreateDialog
          onCreate={async ({ name, description }) => {
            const p = await createProject({
              organization_id: orgId,
              name,
              description,
            })
            setShowNewProjectDialog(false)
            await refreshProjects()
            if (p) setExpandedProjectId(p.id)
          }}
          onClose={() => setShowNewProjectDialog(false)}
        />
      )}
      {showEditProjectId && (
        <ProjectEditDialog
          project={projects.find((p) => p.id === showEditProjectId) ?? null}
          onSave={async (patch) => {
            if (!showEditProjectId) return
            await updateProject(showEditProjectId, patch)
            setShowEditProjectId(null)
            await refreshProjects()
          }}
          onDelete={async () => {
            if (!showEditProjectId) return
            const p = projects.find((x) => x.id === showEditProjectId)
            if (
              !confirm(
                `運行現場「${p?.name ?? ''}」を完全削除しますか?\nメンバー割当・ポイント・履歴も連鎖削除されます。`,
              )
            )
              return
            await deleteProject(showEditProjectId)
            if (expandedProjectId === showEditProjectId) setExpandedProjectId(null)
            setShowEditProjectId(null)
            await refreshProjects()
          }}
          onClose={() => setShowEditProjectId(null)}
        />
      )}
      {showMemberPickerForProject && (
        <ProjectMemberPickerDialog
          candidates={orgMembers.filter(
            (m) =>
              !expandedProjectMembers.some((x) => x.user_id === m.user_id),
          )}
          onPick={async (userId) => {
            if (!showMemberPickerForProject) return
            await addProjectMember(showMemberPickerForProject, userId)
            setShowMemberPickerForProject(null)
            // 展開中の場合はリフレッシュ
            if (expandedProjectId === showMemberPickerForProject) {
              const ms = await fetchProjectMembers(expandedProjectId)
              setExpandedProjectMembers(ms)
            }
          }}
          onClose={() => setShowMemberPickerForProject(null)}
        />
      )}
      {editingPoint && (
        <PointEditDialog
          point={editingPoint}
          onSave={async (patch) => {
            await updatePoint(editingPoint.id, patch)
            setExpandedProjectPoints((prev) =>
              prev.map((p) =>
                p.id === editingPoint.id ? { ...p, ...patch } : p,
              ),
            )
            setEditingPoint(null)
          }}
          onClose={() => setEditingPoint(null)}
        />
      )}
      {pendingNewPoint && expandedProjectId && (
        <PointCreateDialog
          lat={pendingNewPoint.lat}
          lon={pendingNewPoint.lon}
          onCreate={async ({ name, memo }) => {
            const created = await createPoint({
              project_id: expandedProjectId,
              name,
              memo,
              lat: pendingNewPoint.lat,
              lon: pendingNewPoint.lon,
              display_order: expandedProjectPoints.length,
            })
            if (created) {
              setExpandedProjectPoints((prev) => [...prev, created])
            }
            setPendingNewPoint(null)
          }}
          onClose={() => setPendingNewPoint(null)}
        />
      )}
    </div>
  )
}

function MobilityHeader({
  onBack,
  onOpenLogs,
}: {
  onBack: () => void
  onOpenLogs?: () => void
}) {
  return (
    <div className="p-4 bg-white border-b flex items-center gap-3 shrink-0">
      <button
        onClick={onBack}
        className="p-1 rounded hover:bg-slate-100 text-slate-500"
        title="現場一覧に戻る"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <Car className="h-5 w-5 text-indigo-600" />
      <h1 className="text-lg font-bold flex-1">モビリティ</h1>
      <span className="px-2 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 border border-amber-300">
        開発中
      </span>
      {onOpenLogs && (
        <button
          onClick={onOpenLogs}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
          title="日別運行ログを見る"
        >
          <Calendar className="h-4 w-4" />
          運行ログ
        </button>
      )}
    </div>
  )
}

// ユーザーモード時のサイドパネル: 稼働中ドライバー + 組織メンバー一覧
function UserModeSidebar({
  activeAssignments,
  vehicles,
  orgMembers,
  loading,
  expandedUserId,
  selectedId,
  forceLeaveBusyId,
  ageMsForAssignment,
  staleThresholdMs,
  onToggleExpand,
  onSelect,
  onDeleteSection,
  historyReloadKey,
  onForceLeave,
  onInviteByPhone,
}: {
  activeAssignments: Map<string, AssignmentWithNames>
  vehicles: Vehicle[]
  orgMembers: OrgMemberRow[]
  loading: boolean
  expandedUserId: string | null
  selectedId: string | null
  forceLeaveBusyId: string | null
  ageMsForAssignment: (assignmentId: string) => number | null
  staleThresholdMs: number
  onToggleExpand: (userId: string) => void
  onSelect: (assignmentId: string) => void
  onDeleteSection?: (assignmentId: string, label: string) => void
  historyReloadKey?: number
  onForceLeave: (
    assignmentId: string,
    driverName: string | null,
    vehicleName: string,
  ) => Promise<void>
  onInviteByPhone: () => void
}) {
  const activeUsers = useMemo(() => {
    const rows: {
      userId: string
      assignmentId: string
      driverName: string
      vehicleName: string
      startedAt: string
      destinationName: string | null
    }[] = []
    for (const a of activeAssignments.values()) {
      const v = vehicles.find((vv) => vv.id === a.vehicle_id)
      rows.push({
        userId: a.user_id,
        assignmentId: a.id,
        driverName: a.driver_name || '(名前未設定)',
        vehicleName: v?.name ?? '(不明車両)',
        startedAt: a.started_at,
        destinationName: a.destination_point?.name ?? null,
      })
    }
    return rows
  }, [activeAssignments, vehicles])

  const activeUserIds = useMemo(
    () => new Set(activeUsers.map((u) => u.userId)),
    [activeUsers],
  )

  return (
    <div className="space-y-5">
      {/* 稼働中ドライバー */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-5 rounded bg-emerald-500" />
          <h2 className="text-sm font-semibold text-slate-700">
            稼働中ドライバー ({activeUsers.length})
          </h2>
        </div>
        {activeUsers.length === 0 ? (
          <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
            現在乗車中のドライバーはいません
          </div>
        ) : (
          <ul className="space-y-1.5">
            {activeUsers.map((u) => {
              const expanded = expandedUserId === u.userId
              const active = Array.from(activeAssignments.values()).find(
                (a) => a.user_id === u.userId,
              )
              return (
                <li
                  key={u.userId}
                  className={`bg-white rounded border ${
                    expanded ? 'ring-1 ring-indigo-500 border-indigo-400' : 'hover:border-indigo-400'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggleExpand(u.userId)}
                    className="w-full flex items-center gap-3 p-3 text-left"
                  >
                    <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-emerald-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {u.driverName}
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
                        <Car className="h-3 w-3" />
                        {u.vehicleName}
                        <span className="mx-1">·</span>
                        {new Date(u.startedAt).toLocaleTimeString('ja-JP', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        〜
                      </div>
                      {u.destinationName && (
                        <div className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5 truncate">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">行き先: {u.destinationName}</span>
                        </div>
                      )}
                    </div>
                    {(() => {
                      const age = ageMsForAssignment(u.assignmentId)
                      if (age != null && age > staleThresholdMs) {
                        return (
                          <span
                            className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 border border-red-300"
                            title={`最終 ping から ${formatAgeShort(age)}`}
                          >
                            ⚠ 通信断 {formatAgeShort(age)}
                          </span>
                        )
                      }
                      return (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                          乗車中
                        </span>
                      )
                    })()}
                    <ChevronDown
                      className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
                        expanded ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {/* 管理者による強制降車 */}
                  <div className="px-3 pb-2 flex justify-end">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void onForceLeave(
                          u.assignmentId,
                          u.driverName,
                          u.vehicleName,
                        )
                      }}
                      disabled={forceLeaveBusyId === u.assignmentId}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                      title="管理者権限で降車させる"
                    >
                      {forceLeaveBusyId === u.assignmentId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <LogOut className="h-3 w-3" />
                      )}
                      強制降車
                    </button>
                  </div>
                  {expanded && (
                    <UserInlineDetail
                      userId={u.userId}
                      activeAssignment={active ?? null}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      onDeleteSection={onDeleteSection}
                      historyReloadKey={historyReloadKey}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 組織メンバー一覧 */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-5 rounded bg-indigo-500" />
          <h2 className="text-sm font-semibold text-slate-700 flex-1">
            組織メンバー ({orgMembers.length})
          </h2>
          {PHONE_INVITE_ENABLED && (
            <button
              type="button"
              onClick={onInviteByPhone}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
              title="電話番号でドライバーを招待する"
            >
              <Phone className="h-3 w-3" />
              電話で招待
            </button>
          )}
        </div>
        {loading ? (
          <div className="p-4 text-center text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            読み込み中...
          </div>
        ) : orgMembers.length === 0 ? (
          <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
            メンバーがいません
          </div>
        ) : (
          <ul className="space-y-1.5">
            {orgMembers.map((m) => {
              const isActive = activeUserIds.has(m.user_id)
              const expanded = expandedUserId === m.user_id
              const active = Array.from(activeAssignments.values()).find(
                (a) => a.user_id === m.user_id,
              )
              return (
                <li
                  key={m.user_id}
                  className={`bg-white rounded border ${
                    expanded ? 'ring-1 ring-indigo-500 border-indigo-400' : 'hover:border-indigo-400'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggleExpand(m.user_id)}
                    className="w-full flex items-center gap-2 p-2.5 text-left"
                  >
                    <div
                      className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${
                        isActive ? 'bg-emerald-100' : 'bg-slate-100'
                      }`}
                    >
                      <User
                        className={`h-3.5 w-3.5 ${
                          isActive ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {m.full_name || m.email}
                      </div>
                      {m.full_name && m.email !== m.full_name && (
                        <div className="text-[10px] text-slate-500 truncate">
                          {m.email}
                        </div>
                      )}
                    </div>
                    {m.role === 'admin' && (
                      <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">
                        管理者
                      </span>
                    )}
                    {isActive && (
                      <span className="shrink-0 text-[10px] text-emerald-600">●</span>
                    )}
                    <ChevronDown
                      className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
                        expanded ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {expanded && (
                    <UserInlineDetail
                      userId={m.user_id}
                      activeAssignment={active ?? null}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      onDeleteSection={onDeleteSection}
                      historyReloadKey={historyReloadKey}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function VehicleRow({
  vehicle,
  active,
  activeAssignment,
  expanded,
  selectedId,
  onToggleExpand,
  onSelect,
  onDeleteSection,
  historyReloadKey,
  onEdit,
}: {
  vehicle: Vehicle
  active: boolean
  activeAssignment: AssignmentWithNames | null
  expanded: boolean
  selectedId: string | null
  onToggleExpand: () => void
  onSelect: (assignmentId: string) => void
  onDeleteSection?: (assignmentId: string, label: string) => void
  historyReloadKey?: number
  onEdit: () => void
}) {
  const Icon = KIND_ICON[vehicle.kind]
  return (
    <li
      className={`bg-white rounded border ${
        expanded ? 'ring-1 ring-indigo-500 border-indigo-400' : 'hover:border-indigo-400'
      }`}
    >
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <div
            className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
              active ? 'bg-emerald-100' : 'bg-slate-100'
            }`}
          >
            <Icon
              className={`h-4 w-4 ${active ? 'text-emerald-700' : 'text-slate-500'}`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-800 truncate">
              {vehicle.name}
              {vehicle.plate_or_serial && (
                <span className="text-slate-400 text-xs ml-1.5">
                  ({vehicle.plate_or_serial})
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-500">
              {KIND_LABEL[vehicle.kind]}
              {active && <span className="ml-2 text-emerald-600">● 稼働中</span>}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded shrink-0"
          title="編集"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded shrink-0"
          title={expanded ? '詳細を閉じる' : '詳細を表示'}
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {expanded && (
        <VehicleInlineDetail
          vehicleId={vehicle.id}
          activeAssignment={activeAssignment}
          selectedId={selectedId}
          onSelect={onSelect}
          onDeleteSection={onDeleteSection}
          historyReloadKey={historyReloadKey}
        />
      )}
    </li>
  )
}

// 車両新規/編集ダイアログ
function VehicleEditDialog({
  mode,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  mode: 'create' | 'edit'
  organizationId: string
  initial?: Vehicle
  onSave: (input: {
    name: string
    plate_or_serial: string | null
    kind: VehicleKind
    memo: string | null
    active: boolean
  }) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [plate, setPlate] = useState(initial?.plate_or_serial ?? '')
  const [kind, setKind] = useState<VehicleKind>(initial?.kind ?? 'car')
  const [memo, setMemo] = useState(initial?.memo ?? '')
  const [active, setActive] = useState(initial?.active ?? true)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        plate_or_serial: plate.trim() || null,
        kind,
        memo: memo.trim() || null,
        active,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">
            {mode === 'create' ? '新規車両' : '車両を編集'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              車両名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 2号車、バックホウA"
              className="w-full px-2 py-1.5 text-sm border rounded"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              ナンバー / 機械番号
            </label>
            <input
              type="text"
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">種別</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as VehicleKind)}
              className="w-full px-2 py-1.5 text-sm border rounded bg-white"
            >
              <option value="car">普通車</option>
              <option value="truck">トラック</option>
              <option value="heavy_equipment">重機</option>
              <option value="other">その他</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">メモ</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="任意"
              className="w-full px-2 py-1.5 text-sm border rounded h-16"
            />
          </div>
          {mode === 'edit' && (
            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span className="text-xs">
                稼働中の車両 (廃車/売却時はチェックを外す)
              </span>
            </label>
          )}
          {mode === 'edit' && onDelete && (
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={onDelete}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                完全削除
              </button>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex gap-2 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// 電話番号でドライバーを招待するダイアログ (Edge Function invite-member を phone で呼ぶ)
function PhoneInviteDialog({
  organizationId,
  onClose,
}: {
  organizationId: string
  onClose: () => void
}) {
  const [phoneInput, setPhoneInput] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const normalized = normalizeJpPhone(phoneInput)
  const canSubmit = !!normalized && !busy

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (!normalized) {
      setError('電話番号の形式が正しくありません (例: 090-1234-5678)')
      return
    }
    setBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        'invite-member',
        {
          body: {
            organization_id: organizationId,
            phone: normalized,
            org_role: role,
          },
        },
      )
      if (fnErr) {
        let msg = fnErr.message || '招待に失敗しました'
        const ctx = (fnErr as unknown as { context?: { body?: string } }).context
        if (ctx?.body) {
          try {
            const parsed = JSON.parse(ctx.body) as { error?: string }
            if (parsed.error) msg = parsed.error
          } catch {
            /* ignore */
          }
        }
        throw new Error(msg)
      }
      const result = (data ?? {}) as {
        ok?: boolean
        status?: string
        note?: string
        error?: string
      }
      if (!result.ok) throw new Error(result.error ?? '招待に失敗しました')
      setMessage(
        result.status === 'added_existing_user'
          ? `${normalized} は既にアカウントを持っているため、組織に追加しました。`
          : result.note ??
              `${normalized} を招待しました。相手方が電話番号ログインすると自動で組織に追加されます。`,
      )
      setPhoneInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-indigo-600" />
            <h3 className="text-base font-semibold">電話番号で招待</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              電話番号 <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="090-1234-5678"
              autoFocus
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
            <div className="text-[10px] text-slate-500 mt-1">
              {normalized ? (
                <span className="text-emerald-700">
                  正規化: <span className="font-mono">{normalized}</span>
                </span>
              ) : (
                phoneInput && '⚠ 電話番号の形式が正しくありません'
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">役割</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              className="w-full px-2 py-1.5 text-sm border rounded bg-white"
            >
              <option value="member">一般メンバー</option>
              <option value="admin">管理者</option>
            </select>
          </div>
          <div className="p-3 bg-slate-50 border rounded text-[11px] text-slate-600 leading-relaxed">
            招待の流れ:
            <br />
            1. 招待を送信 → 一時 pending として保存
            <br />
            2. 相手方がアプリで「電話番号でログイン」→ SMS で 6 桁コード受信
            <br />
            3. コード入力後にアカウント作成 → 自動的にこの組織に所属
            <br />
            <span className="text-amber-700">
              ※ SMS 送信料は Supabase Auth プロバイダ (Twilio 等) 経由でかかります
            </span>
          </div>
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {error}
            </div>
          )}
          {message && (
            <div className="p-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700">
              {message}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
            >
              閉じる
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              招待を送る
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// インライン展開の詳細ペイン (共通ロジック)
// -----------------------------------------------------------------------------
function startOfTodayLocalIso(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

interface HistoryDetailProps {
  history: AssignmentWithNames[]
  historyLoading: boolean
  positionsByAssignment: Map<string, MobilityPosition[]>
  vehiclesById: Map<string, Vehicle>
  currentSpeedKmh: number | null
  todayDistanceM: number
  distanceLabel: string
  selectedId: string | null
  onSelect: (assignmentId: string) => void
  /** 削除ボタン用。null なら削除ボタンを出さない */
  onDeleteSection?: (assignmentId: string, label: string) => void
  /** 履歴の 1 行に何を「主タイトル」として出すか。車両詳細ならドライバー名、ユーザー詳細なら車両名 */
  primaryLabel: (a: AssignmentWithNames) => string
}

function InlineDetailBody({
  history,
  historyLoading,
  positionsByAssignment,
  currentSpeedKmh,
  todayDistanceM,
  distanceLabel,
  selectedId,
  onSelect,
  onDeleteSection,
  primaryLabel,
}: HistoryDetailProps) {
  return (
    <div className="border-t bg-slate-50/60 p-3 space-y-3">
      {/* 速度・走行距離 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2 bg-white rounded border">
          <div className="text-[10px] text-slate-500">現在速度</div>
          <div className="text-xl font-bold leading-tight text-slate-800">
            {currentSpeedKmh != null && currentSpeedKmh >= 0
              ? Math.round(currentSpeedKmh)
              : '—'}
            <span className="text-[10px] font-normal text-slate-500 ml-1">km/h</span>
          </div>
        </div>
        <div className="p-2 bg-white rounded border">
          <div className="text-[10px] text-slate-500">{distanceLabel}</div>
          <div className="text-xl font-bold leading-tight text-slate-800">
            {(todayDistanceM / 1000).toFixed(1)}
            <span className="text-[10px] font-normal text-slate-500 ml-1">km</span>
          </div>
        </div>
      </div>

      {/* 運行履歴 */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-0.5 h-4 rounded bg-slate-400" />
          <h3 className="text-xs font-semibold text-slate-700 flex-1">
            運行履歴 ({history.length} セクション)
          </h3>
          {historyLoading && (
            <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />
          )}
          <span className="text-[10px] text-slate-500">
            クリックで地図に軌跡
          </span>
        </div>
        {history.length === 0 && !historyLoading ? (
          <div className="p-2 bg-white rounded border text-[11px] text-slate-400 text-center">
            履歴はありません
          </div>
        ) : (
          <ul className="space-y-1">
            {history.map((a) => {
              const isSelected = selectedId === a.id
              const rowsToday = positionsByAssignment.get(a.id)
              const distanceKm = rowsToday
                ? computeTotalDistanceMeters(rowsToday) / 1000
                : null
              return (
                <li key={a.id}>
                  <div
                    className={`flex items-center rounded border text-[11px] transition ${
                      isSelected
                        ? 'bg-indigo-50 ring-2 ring-indigo-500 border-indigo-500'
                        : 'bg-white hover:border-indigo-400'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(a.id)}
                      className="flex-1 flex items-center gap-2 p-2 text-left min-w-0"
                      title={
                        isSelected
                          ? '選択中 (もう一度クリックで解除)'
                          : 'クリックでこのセクションの軌跡を地図に表示'
                      }
                    >
                      <span
                        className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                          isSelected ? 'bg-indigo-600' : 'bg-slate-300'
                        }`}
                      />
                      <span
                        className={`flex-1 min-w-0 truncate ${
                          isSelected
                            ? 'font-semibold text-indigo-800'
                            : 'font-medium'
                        }`}
                      >
                        {primaryLabel(a)}
                      </span>
                      <span className="text-slate-500 shrink-0">
                        {new Date(a.started_at).toLocaleString('ja-JP', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {a.ended_at ? (
                          <>
                            {' '}
                            〜{' '}
                            {new Date(a.ended_at).toLocaleTimeString('ja-JP', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </>
                        ) : (
                          <span className="ml-1 text-emerald-600">(稼働中)</span>
                        )}
                      </span>
                      <span
                        className="text-slate-500 shrink-0 w-12 text-right font-medium"
                        title={
                          distanceKm != null
                            ? '本日ログから計算した走行距離'
                            : '本日以外の割当のため距離は非表示'
                        }
                      >
                        {distanceKm != null ? `${distanceKm.toFixed(1)}km` : '—'}
                      </span>
                    </button>
                    {onDeleteSection && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const label = `${primaryLabel(a)} · ${new Date(
                            a.started_at,
                          ).toLocaleString('ja-JP', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                          onDeleteSection(a.id, label)
                        }}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 shrink-0 rounded-r"
                        title="このセクションを削除 (位置ログも消える)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function VehicleInlineDetail({
  vehicleId,
  activeAssignment,
  selectedId,
  onSelect,
  onDeleteSection,
  historyReloadKey,
}: {
  vehicleId: string
  activeAssignment: AssignmentWithNames | null
  selectedId: string | null
  onSelect: (assignmentId: string) => void
  onDeleteSection?: (assignmentId: string, label: string) => void
  historyReloadKey?: number
}) {
  const {
    vehicles,
    fetchAssignmentHistory,
    fetchPositionsForVehicleSince,
  } = useMobilityStore()

  const vehiclesById = useMemo(() => {
    const m = new Map<string, Vehicle>()
    for (const v of vehicles) m.set(v.id, v)
    return m
  }, [vehicles])

  const [history, setHistory] = useState<AssignmentWithNames[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [todayPositions, setTodayPositions] = useState<MobilityPosition[]>([])

  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    void (async () => {
      const rows = await fetchAssignmentHistory(vehicleId)
      if (!cancelled) {
        setHistory(rows)
        setHistoryLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [vehicleId, fetchAssignmentHistory, historyReloadKey])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const rows = await fetchPositionsForVehicleSince(
        vehicleId,
        startOfTodayLocalIso(),
      )
      if (!cancelled) setTodayPositions(rows)
    }
    void load()
    const timer = activeAssignment ? setInterval(load, 20_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [vehicleId, activeAssignment, fetchPositionsForVehicleSince])

  const positionsByAssignment = useMemo(() => {
    const map = new Map<string, MobilityPosition[]>()
    for (const p of todayPositions) {
      const arr = map.get(p.assignment_id)
      if (arr) arr.push(p)
      else map.set(p.assignment_id, [p])
    }
    return map
  }, [todayPositions])

  const todayDistanceM = useMemo(() => {
    let total = 0
    for (const rows of positionsByAssignment.values()) {
      total += computeTotalDistanceMeters(rows)
    }
    return total
  }, [positionsByAssignment])

  const currentSpeedKmh = useMemo(() => {
    if (!activeAssignment) return null
    const rows = positionsByAssignment.get(activeAssignment.id)
    if (!rows || rows.length === 0) return null
    const last = rows[rows.length - 1]
    return last.speed_kmh
  }, [activeAssignment, positionsByAssignment])

  return (
    <InlineDetailBody
      history={history}
      historyLoading={historyLoading}
      positionsByAssignment={positionsByAssignment}
      vehiclesById={vehiclesById}
      currentSpeedKmh={currentSpeedKmh}
      todayDistanceM={todayDistanceM}
      distanceLabel="本日走行 (この車両)"
      selectedId={selectedId}
      onSelect={onSelect}
      onDeleteSection={onDeleteSection}
      primaryLabel={(a) => a.driver_name || '(名前未設定)'}
    />
  )
}

function UserInlineDetail({
  userId,
  activeAssignment,
  selectedId,
  onSelect,
  onDeleteSection,
  historyReloadKey,
}: {
  userId: string
  activeAssignment: AssignmentWithNames | null
  selectedId: string | null
  onSelect: (assignmentId: string) => void
  onDeleteSection?: (assignmentId: string, label: string) => void
  historyReloadKey?: number
}) {
  const {
    vehicles,
    fetchUserAssignmentHistory,
    fetchPositionsForUserSince,
  } = useMobilityStore()

  const vehiclesById = useMemo(() => {
    const m = new Map<string, Vehicle>()
    for (const v of vehicles) m.set(v.id, v)
    return m
  }, [vehicles])

  const [history, setHistory] = useState<AssignmentWithNames[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [todayPositions, setTodayPositions] = useState<MobilityPosition[]>([])

  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    void (async () => {
      const rows = await fetchUserAssignmentHistory(userId)
      if (!cancelled) {
        setHistory(rows)
        setHistoryLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userId, fetchUserAssignmentHistory, historyReloadKey])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const rows = await fetchPositionsForUserSince(
        userId,
        startOfTodayLocalIso(),
      )
      if (!cancelled) setTodayPositions(rows)
    }
    void load()
    const timer = activeAssignment ? setInterval(load, 20_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [userId, activeAssignment, fetchPositionsForUserSince])

  const positionsByAssignment = useMemo(() => {
    const map = new Map<string, MobilityPosition[]>()
    for (const p of todayPositions) {
      const arr = map.get(p.assignment_id)
      if (arr) arr.push(p)
      else map.set(p.assignment_id, [p])
    }
    return map
  }, [todayPositions])

  const todayDistanceM = useMemo(() => {
    let total = 0
    for (const rows of positionsByAssignment.values()) {
      total += computeTotalDistanceMeters(rows)
    }
    return total
  }, [positionsByAssignment])

  const currentSpeedKmh = useMemo(() => {
    if (!activeAssignment) return null
    const rows = positionsByAssignment.get(activeAssignment.id)
    if (!rows || rows.length === 0) return null
    const last = rows[rows.length - 1]
    return last.speed_kmh
  }, [activeAssignment, positionsByAssignment])

  return (
    <InlineDetailBody
      history={history}
      historyLoading={historyLoading}
      positionsByAssignment={positionsByAssignment}
      vehiclesById={vehiclesById}
      currentSpeedKmh={currentSpeedKmh}
      todayDistanceM={todayDistanceM}
      distanceLabel="本日走行 (この人)"
      selectedId={selectedId}
      onSelect={onSelect}
      onDeleteSection={onDeleteSection}
      primaryLabel={(a) => vehiclesById.get(a.vehicle_id)?.name ?? '(不明車両)'}
    />
  )
}

// -----------------------------------------------------------------------------
// 運行現場 左サイドパネル
// -----------------------------------------------------------------------------
function ProjectsLeftPanel({
  projects,
  projectsLoading,
  expandedProjectId,
  expandedProjectMembers,
  expandedProjectPoints,
  orgMembers,
  addPointMode,
  onToggleExpand,
  onNewProject,
  onEditProject,
  onOpenMemberPicker,
  onRemoveMember,
  onEnterAddPointMode,
  onCancelAddPointMode,
  onEditPoint,
  onDeletePoint,
}: {
  projects: MobilityProject[]
  projectsLoading: boolean
  expandedProjectId: string | null
  expandedProjectMembers: MobilityProjectMember[]
  expandedProjectPoints: MobilityProjectPoint[]
  orgMembers: OrgMemberRow[]
  addPointMode: boolean
  onToggleExpand: (id: string) => void
  onNewProject: () => void
  onEditProject: (id: string) => void
  onOpenMemberPicker: (projectId: string) => void
  onRemoveMember: (projectId: string, userId: string) => Promise<void>
  onEnterAddPointMode: () => void
  onCancelAddPointMode: () => void
  onEditPoint: (p: MobilityProjectPoint) => void
  onDeletePoint: (pointId: string) => Promise<void>
}) {
  const memberNameMap = useMemo(() => {
    const m = new Map<string, OrgMemberRow>()
    for (const r of orgMembers) m.set(r.user_id, r)
    return m
  }, [orgMembers])

  const active = projects.filter((p) => p.active)
  const inactive = projects.filter((p) => !p.active)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Folder className="h-4 w-4 text-indigo-600" />
        <h2 className="text-sm font-semibold text-slate-700 flex-1">
          運行現場 ({projects.length})
        </h2>
        <button
          type="button"
          onClick={onNewProject}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
        >
          <Plus className="h-3 w-3" />
          新規
        </button>
      </div>

      {projectsLoading && projects.length === 0 ? (
        <div className="p-4 text-center text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
          読み込み中...
        </div>
      ) : projects.length === 0 ? (
        <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
          運行現場がありません。「新規」から作成してください。
        </div>
      ) : (
        <>
          <ul className="space-y-1.5">
            {active.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                expanded={expandedProjectId === p.id}
                members={
                  expandedProjectId === p.id ? expandedProjectMembers : []
                }
                points={
                  expandedProjectId === p.id ? expandedProjectPoints : []
                }
                memberNameMap={memberNameMap}
                addPointMode={addPointMode && expandedProjectId === p.id}
                onToggleExpand={() => onToggleExpand(p.id)}
                onEdit={() => onEditProject(p.id)}
                onOpenMemberPicker={() => onOpenMemberPicker(p.id)}
                onRemoveMember={(userId) => onRemoveMember(p.id, userId)}
                onEnterAddPointMode={onEnterAddPointMode}
                onCancelAddPointMode={onCancelAddPointMode}
                onEditPoint={onEditPoint}
                onDeletePoint={onDeletePoint}
              />
            ))}
          </ul>
          {inactive.length > 0 && (
            <>
              <div className="flex items-center gap-2 mt-3 mb-1">
                <div className="w-1 h-4 rounded bg-slate-400" />
                <h3 className="text-xs font-medium text-slate-500">
                  無効化済み ({inactive.length})
                </h3>
              </div>
              <ul className="space-y-1.5 opacity-60">
                {inactive.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    expanded={expandedProjectId === p.id}
                    members={
                      expandedProjectId === p.id ? expandedProjectMembers : []
                    }
                    points={
                      expandedProjectId === p.id ? expandedProjectPoints : []
                    }
                    memberNameMap={memberNameMap}
                    addPointMode={
                      addPointMode && expandedProjectId === p.id
                    }
                    onToggleExpand={() => onToggleExpand(p.id)}
                    onEdit={() => onEditProject(p.id)}
                    onOpenMemberPicker={() => onOpenMemberPicker(p.id)}
                    onRemoveMember={(userId) => onRemoveMember(p.id, userId)}
                    onEnterAddPointMode={onEnterAddPointMode}
                    onCancelAddPointMode={onCancelAddPointMode}
                    onEditPoint={onEditPoint}
                    onDeletePoint={onDeletePoint}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ProjectRow({
  project,
  expanded,
  members,
  points,
  memberNameMap,
  addPointMode,
  onToggleExpand,
  onEdit,
  onOpenMemberPicker,
  onRemoveMember,
  onEnterAddPointMode,
  onCancelAddPointMode,
  onEditPoint,
  onDeletePoint,
}: {
  project: MobilityProject
  expanded: boolean
  members: MobilityProjectMember[]
  points: MobilityProjectPoint[]
  memberNameMap: Map<string, OrgMemberRow>
  addPointMode: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onOpenMemberPicker: () => void
  onRemoveMember: (userId: string) => Promise<void>
  onEnterAddPointMode: () => void
  onCancelAddPointMode: () => void
  onEditPoint: (p: MobilityProjectPoint) => void
  onDeletePoint: (pointId: string) => Promise<void>
}) {
  return (
    <li
      className={`bg-white rounded border ${
        expanded ? 'ring-1 ring-indigo-500 border-indigo-400' : 'hover:border-indigo-400'
      }`}
    >
      <div className="flex items-center gap-2 p-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
            <Folder className="h-3.5 w-3.5 text-indigo-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-800 truncate">
              {project.name}
            </div>
            {project.description && (
              <div className="text-[10px] text-slate-500 truncate">
                {project.description}
              </div>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded shrink-0"
          title="現場を編集"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded shrink-0"
          title={expanded ? '折りたたむ' : '展開'}
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {expanded && (
        <div className="border-t bg-slate-50/60 p-2.5 space-y-3">
          {/* メンバー */}
          <section>
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="w-0.5 h-4 rounded bg-emerald-500" />
              <h3 className="text-[11px] font-semibold text-slate-700 flex-1">
                ドライバー ({members.length})
              </h3>
              <button
                type="button"
                onClick={onOpenMemberPicker}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-emerald-600 text-white rounded hover:bg-emerald-700"
              >
                <UserPlus className="h-3 w-3" /> 追加
              </button>
            </div>
            {members.length === 0 ? (
              <div className="p-2 bg-white rounded border text-[11px] text-slate-400 text-center">
                ドライバー未割当
              </div>
            ) : (
              <ul className="space-y-1">
                {members.map((m) => {
                  const om = memberNameMap.get(m.user_id)
                  return (
                    <li
                      key={m.user_id}
                      className="flex items-center gap-1.5 p-1.5 bg-white rounded border text-[11px]"
                    >
                      <User className="h-3 w-3 text-slate-400 shrink-0" />
                      <span className="flex-1 min-w-0 truncate">
                        {om?.full_name || om?.email || m.user_id.slice(0, 8)}
                      </span>
                      {om?.role === 'admin' && (
                        <span className="shrink-0 px-1 py-0 text-[9px] rounded bg-amber-100 text-amber-800">
                          管理者
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void onRemoveMember(m.user_id)}
                        className="p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                        title="削除"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* ポイント */}
          <section>
            <div className="flex items-center gap-1.5 mb-1.5">
              <div className="w-0.5 h-4 rounded bg-indigo-500" />
              <h3 className="text-[11px] font-semibold text-slate-700 flex-1">
                ポイント ({points.length})
              </h3>
              {addPointMode ? (
                <button
                  type="button"
                  onClick={onCancelAddPointMode}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-slate-500 text-white rounded hover:bg-slate-600"
                >
                  取消
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onEnterAddPointMode}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-indigo-600 text-white rounded hover:bg-indigo-700"
                >
                  <Plus className="h-3 w-3" /> 地図から追加
                </button>
              )}
            </div>
            {points.length === 0 ? (
              <div className="p-2 bg-white rounded border text-[11px] text-slate-400 text-center">
                ポイント未登録
              </div>
            ) : (
              <ul className="space-y-1">
                {points.map((pt) => (
                  <li
                    key={pt.id}
                    className="flex items-center gap-1.5 p-1.5 bg-white rounded border text-[11px]"
                  >
                    <MapPin className="h-3 w-3 text-indigo-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{pt.name}</div>
                      {pt.memo && (
                        <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                          {pt.memo}
                        </div>
                      )}
                      {/* 旧「種別」データが残っていれば控えめに表示 (新規は memo のみ) */}
                      {pt.kind && !pt.memo && (
                        <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                          {pt.kind}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onEditPoint(pt)}
                      className="p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                      title="編集"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeletePoint(pt.id)}
                      className="p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </li>
  )
}

// -----------------------------------------------------------------------------
// 運行現場ダイアログ (作成 / 編集 / メンバー追加 / ポイント編集)
// MobilityProjectsPage / MobilityProjectPage と同じ実装だが、この画面内で完結させる
// -----------------------------------------------------------------------------

function ProjectCreateDialog({
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
          <h3 className="text-base font-semibold">新規運行現場</h3>
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

function ProjectEditDialog({
  project,
  onSave,
  onDelete,
  onClose,
}: {
  project: MobilityProject | null
  onSave: (patch: {
    name: string
    description: string | null
    active: boolean
  }) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [active, setActive] = useState(project?.active ?? true)
  const [busy, setBusy] = useState(false)
  if (!project) return null
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
          <h3 className="text-base font-semibold">運行現場を編集</h3>
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

function ProjectMemberPickerDialog({
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
              追加可能なメンバーがいません
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

function PointEditDialog({
  point,
  onSave,
  onClose,
}: {
  point: MobilityProjectPoint
  onSave: (patch: {
    name: string
    memo: string | null
  }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(point.name)
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
            <label className="block text-xs text-slate-600 mb-1">
              ポイント名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">備考</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="任意 (例: 土取場、採石場、農場A、雪捨場 など)"
              className="w-full px-2 py-1.5 text-sm border rounded h-20"
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

function PointCreateDialog({
  lat,
  lon,
  onCreate,
  onClose,
}: {
  lat: number
  lon: number
  onCreate: (input: { name: string; memo: string | null }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [memo, setMemo] = useState('')
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
          <h3 className="text-base font-semibold">ポイントを追加</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              ポイント名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 土取場A"
              autoFocus
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">備考</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="任意 (例: 土取場、採石場、農場A、雪捨場 など)"
              className="w-full px-2 py-1.5 text-sm border rounded h-20"
            />
          </div>
          <div className="text-[10px] text-slate-500 font-mono">
            座標: {lat.toFixed(6)}, {lon.toFixed(6)}
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
                memo: memo.trim() || null,
              })
              setBusy(false)
            }}
            disabled={!name.trim() || busy}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            追加
          </button>
        </div>
      </div>
    </div>
  )
}
