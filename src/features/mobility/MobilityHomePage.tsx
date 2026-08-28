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
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Send,
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
import { useMobilityMessagesStore } from '@/stores/mobilityMessagesStore'
import { MobilityInstructionDialog } from '@/features/mobility/MobilityInstructionDialog'
import { MobilityChatPanel } from '@/features/mobility/MobilityChatPanel'
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
    vehiclesError,
    activeAssignments,
    fetchVehicles,
    fetchActiveAssignments,
    createVehicle,
    updateVehicle,
    deleteVehicle,
    endAssignment,
    deleteAssignment,
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
  // 位置マップは明示的セレクタで購読 (再レンダートリガー確実化)
  const latestPositionsByAssignment = useMobilityStore(
    (s) => s.latestPositionsByAssignment,
  )

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  // 指示 / 報告 / チャット の Realtime 購読
  const subscribeMessages = useMobilityMessagesStore((s) => s.subscribe)
  const unsubscribeMessages = useMobilityMessagesStore((s) => s.unsubscribe)
  useEffect(() => {
    if (!orgId) return
    subscribeMessages(orgId)
    return () => {
      unsubscribeMessages()
    }
  }, [orgId, subscribeMessages, unsubscribeMessages])

  // 指示ダイアログの state (宛先プリセット付き)
  const [instructionDialog, setInstructionDialog] = useState<{
    channelKind: 'direct' | 'project'
    channelUserId: string | null
    channelProjectId: string | null
    driverLabel: string | null
    projectLabel: string | null
    /** 地図のポイントから開いた場合の行き先 */
    pointId?: string | null
  } | null>(null)

  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [orgMembers, setOrgMembers] = useState<OrgMemberRow[]>([])
  const [orgMembersLoading, setOrgMembersLoading] = useState(false)
  const [showPhoneInvite, setShowPhoneInvite] = useState(false)
  // 左サイドバー タブ切替
  const [sidebarTab, setSidebarTab] = useState<'drivers' | 'vehicles' | 'projects'>(
    'drivers',
  )

  // カテゴリ (左パネル) の state
  const [projects, setProjects] = useState<MobilityProject[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [expandedProjectPoints, setExpandedProjectPoints] = useState<
    MobilityProjectPoint[]
  >([])
  // 地図には全カテゴリのポイントを出す。サイドバーは展開中のカテゴリだけを
  // 扱うので expandedProjectPoints とは別に持つ。
  const [allProjectPoints, setAllProjectPoints] = useState<MobilityProjectPoint[]>([])
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
  // 左サイドバー / 右パネル (チャット等) の折りたたみ状態
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  // 運行履歴で選択中の「セクション」(1 回の乗車 = 1 assignment)。単選択。
  // 選択されている間、その assignment の軌跡だけが地図に表示される。
  // 運行履歴で選択中のセクション id 群 (0 or 1 or 複数)。
  //   - セクション行タップ: 単選択トグル ([id] ↔ [])
  //   - 日ヘッダタップ: その日全部 (完全一致なら解除)
  const [selectedSectionAssignmentIds, setSelectedSectionAssignmentIds] =
    useState<string[]>([])

  const selectSection = useCallback((assignmentId: string) => {
    setSelectedSectionAssignmentIds((prev) =>
      prev.length === 1 && prev[0] === assignmentId ? [] : [assignmentId],
    )
  }, [])

  const selectSectionsByDay = useCallback((assignmentIds: string[]) => {
    setSelectedSectionAssignmentIds((prev) => {
      // 完全一致トグル解除
      if (
        prev.length === assignmentIds.length &&
        prev.every((id) => assignmentIds.includes(id))
      ) {
        return []
      }
      return assignmentIds
    })
  }, [])

  const toggleExpandVehicle = useCallback((vehicleId: string) => {
    setExpandedVehicleId((prev) => (prev === vehicleId ? null : vehicleId))
    setExpandedUserId(null)
    setSelectedSectionAssignmentIds([])
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

  // 稼働中 assignment の最新 position をポーリング取得。
  const fetchLatestPositionsStore = useMobilityStore((s) => s.fetchLatestPositions)
  useEffect(() => {
    if (activeAssignments.size === 0) return
    const ids = Array.from(activeAssignments.values()).map((a) => a.id)
    void fetchLatestPositionsStore(ids)
    const id = setInterval(() => {
      const curIds = Array.from(
        useMobilityStore.getState().activeAssignments.values(),
      ).map((a) => a.id)
      if (curIds.length > 0) void fetchLatestPositionsStore(curIds)
    }, 15_000)
    return () => clearInterval(id)
  }, [activeAssignments, fetchLatestPositionsStore])

  // vehicle_assignments の変化 (乗車/降車/強制降車/自動終了) を Realtime + 20秒 poll。
  // FleetMapView も 15 秒 refresh するが、autoUpdate OFF や unmount で停止する
  // 可能性があるため MobilityHomePage 側でも独立して回す。
  // これがないと closed 済 assignment が activeAssignments に残り続けて
  // 「稼働中 1 / 位置未受信」がずっと表示される事故につながる。
  useEffect(() => {
    if (!orgId) return
    void fetchActiveAssignments(orgId)
    const channel = supabase
      .channel(`vehicle-assignments-home-${orgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vehicle_assignments' },
        () => {
          void fetchActiveAssignments(orgId)
        },
      )
      .subscribe()
    const timer = window.setInterval(() => {
      void fetchActiveAssignments(orgId)
    }, 20_000)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
    }
  }, [orgId, fetchActiveAssignments])
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
    setSelectedSectionAssignmentIds([])
  }, [])

  // ユーザー一覧を取得。カテゴリのメンバー割当ダイアログでも使うので mode 問わず取得。
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

  // カテゴリ一覧を取得
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

  // 地図用: 全カテゴリのポイント
  const reloadAllProjectPoints = useCallback(async () => {
    if (projects.length === 0) {
      setAllProjectPoints([])
      return
    }
    const lists = await Promise.all(projects.map((pr) => fetchProjectPoints(pr.id)))
    setAllProjectPoints(lists.flat().filter((p) => p.active))
  }, [projects, fetchProjectPoints])
  useEffect(() => {
    void reloadAllProjectPoints()
  }, [reloadAllProjectPoints])

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
      setSelectedSectionAssignmentIds((prev) =>
        prev.filter((id) => id !== assignmentId),
      )
      if (orgId) await fetchActiveAssignments(orgId)
      setSectionHistoryTick((n) => n + 1)
    },
    [deleteAssignment, fetchActiveAssignments, orgId],
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

      {/* PC は 左: サイドバー(タブ切替) | 右: 地図。狭い画面は縦積み */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* 左サイドバー: タブ切替 (ドライバー / 車両 / カテゴリ) */}
        <div
          className={`flex flex-col border-b lg:border-b-0 lg:border-r bg-white shrink-0 ${
            leftCollapsed ? 'lg:w-8' : 'lg:w-[22rem] xl:w-[25rem]'
          }`}
        >
          {/* 折りたたみ時: トグルボタンのみ縦帯 */}
          {leftCollapsed && (
            <button
              type="button"
              onClick={() => setLeftCollapsed(false)}
              className="hidden lg:flex flex-1 items-center justify-center text-slate-500 hover:bg-slate-100"
              title="サイドバーを展開"
            >
              <ChevronDown className="h-4 w-4 -rotate-90" />
            </button>
          )}
          {/* タブヘッダ (展開時) */}
          <div className={`${leftCollapsed ? 'hidden' : 'flex'} border-b bg-slate-50 shrink-0`}>
            {(
              [
                { key: 'drivers', label: 'ドライバー' },
                { key: 'vehicles', label: '車両' },
                { key: 'projects', label: 'カテゴリ' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setSidebarTab(t.key)}
                className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
                  sidebarTab === t.key
                    ? 'border-indigo-500 text-indigo-700 bg-white'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-white/60'
                }`}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setLeftCollapsed(true)}
              className="hidden lg:block px-2 border-b-2 border-transparent text-slate-400 hover:text-slate-700"
              title="サイドバーを折りたたむ"
            >
              <ChevronDown className="h-4 w-4 rotate-90" />
            </button>
          </div>
          {/* タブ本体 (選択されたパネルのみ表示) */}
          <div className={`${leftCollapsed ? 'hidden' : 'flex-1 overflow-y-auto p-3'}`}>
            {sidebarTab === 'drivers' && (
              <UsersColumn
                organizationId={orgId}
                onOpenInstructionForDriver={(userId, driverName) =>
                  setInstructionDialog({
                    channelKind: 'direct',
                    channelUserId: userId,
                    channelProjectId: null,
                    driverLabel: driverName,
                    projectLabel: null,
                  })
                }
                activeAssignments={activeAssignments}
                vehicles={vehicles}
                orgMembers={orgMembers}
                loading={orgMembersLoading}
                expandedUserId={expandedUserId}
                expandedVehicleId={expandedVehicleId}
                selectedSectionAssignmentIds={selectedSectionAssignmentIds}
                ageMsForAssignment={ageMsForAssignment}
                staleThresholdMs={STALE_THRESHOLD_MS}
                forceLeaveBusyId={forceLeaveBusyId}
                sectionHistoryTick={sectionHistoryTick}
                onToggleExpandUser={toggleExpandUser}
                onToggleExpandVehicle={toggleExpandVehicle}
                onSelectSection={selectSection}
                onSelectSectionsByDay={selectSectionsByDay}
                onDeleteSection={handleDeleteSection}
                onForceLeave={handleForceLeave}
                onEditVehicle={setEditingVehicle}
                onNewVehicle={() => setShowNewDialog(true)}
                onInviteByPhone={() => setShowPhoneInvite(true)}
              />
            )}
            {sidebarTab === 'vehicles' && (
              <VehiclesColumn
                organizationId={orgId}
                onOpenInstructionForDriver={(userId, driverName) =>
                  setInstructionDialog({
                    channelKind: 'direct',
                    channelUserId: userId,
                    channelProjectId: null,
                    driverLabel: driverName,
                    projectLabel: null,
                  })
                }
                activeAssignments={activeAssignments}
                vehicles={vehicles}
                orgMembers={orgMembers}
                loading={orgMembersLoading}
                expandedUserId={expandedUserId}
                expandedVehicleId={expandedVehicleId}
                selectedSectionAssignmentIds={selectedSectionAssignmentIds}
                ageMsForAssignment={ageMsForAssignment}
                staleThresholdMs={STALE_THRESHOLD_MS}
                forceLeaveBusyId={forceLeaveBusyId}
                sectionHistoryTick={sectionHistoryTick}
                onToggleExpandUser={toggleExpandUser}
                onToggleExpandVehicle={toggleExpandVehicle}
                onSelectSection={selectSection}
                onSelectSectionsByDay={selectSectionsByDay}
                onDeleteSection={handleDeleteSection}
                onForceLeave={handleForceLeave}
                onEditVehicle={setEditingVehicle}
                onNewVehicle={() => setShowNewDialog(true)}
                onInviteByPhone={() => setShowPhoneInvite(true)}
              />
            )}
            {sidebarTab === 'projects' && (
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
            )}
          </div>
        </div>

        {/* 中央: 地図 */}
        <div className="h-64 lg:h-auto lg:flex-1 relative min-w-0">
          <FleetMapView
            organizationId={orgId}
            extraTrackAssignmentIds={selectedSectionAssignmentIds}
            projectPoints={allProjectPoints}
            highlightPointId={editingPoint?.id ?? null}
            addPointMode={addPointMode}
            followAssignmentId={followAssignmentId}
            onMapClick={handleMapClickForNewPoint}
            onSelectPoint={(pid) => {
              const pt = allProjectPoints.find((p) => p.id === pid) ?? null
              setEditingPoint(pt)
            }}
            onSelectVehicle={(vid) => {
              setExpandedVehicleId(vid)
              setExpandedUserId(null)
              setSidebarTab('vehicles')
            }}
          />
        </div>

        {/* 右: ドライバー展開時のみ表示 (チャット → 指示送信 → 詳細)。折りたたみ可 */}
        {expandedUserId && (
          <div
            className={`flex flex-col border-t lg:border-t-0 lg:border-l bg-white shrink-0 ${
              rightCollapsed ? 'lg:w-8' : 'lg:w-[24rem] xl:w-[28rem]'
            }`}
          >
            {rightCollapsed ? (
              <button
                type="button"
                onClick={() => setRightCollapsed(false)}
                className="hidden lg:flex flex-1 items-center justify-center text-slate-500 hover:bg-slate-100"
                title="右パネルを展開"
              >
                <ChevronDown className="h-4 w-4 rotate-90" />
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-slate-50 shrink-0">
                  <MessageSquare className="h-4 w-4 text-indigo-600" />
                  <div className="text-sm font-semibold flex-1 truncate">
                    {(() => {
                      const om = orgMembers.find(
                        (m) => m.user_id === expandedUserId,
                      )
                      const active = Array.from(activeAssignments.values()).find(
                        (a) => a.user_id === expandedUserId,
                      )
                      return (
                        active?.driver_name ||
                        om?.full_name ||
                        om?.email ||
                        'ドライバー'
                      )
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => setRightCollapsed(true)}
                    className="hidden lg:block text-slate-400 hover:text-slate-700"
                    title="折りたたむ"
                  >
                    <ChevronDown className="h-4 w-4 -rotate-90" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedUserId(null)}
                    className="text-slate-400 hover:text-slate-700"
                    title="閉じる"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                  {/* 1. チャット (可変高さ、最低 12rem) */}
                  <div className="min-h-[16rem] flex-1 p-2">
                    <MobilityChatPanel
                      key={expandedUserId}
                      organizationId={orgId}
                      channelKind="direct"
                      channelUserId={expandedUserId}
                      channelProjectId={null}
                      senderRole="admin"
                    />
                  </div>
                  {/* 2. 指示送信ボタン (チャットの下) */}
                  <div className="px-3 pb-2">
                    <button
                      type="button"
                      onClick={() => {
                        const om = orgMembers.find(
                          (m) => m.user_id === expandedUserId,
                        )
                        const active = Array.from(
                          activeAssignments.values(),
                        ).find((a) => a.user_id === expandedUserId)
                        const name =
                          active?.driver_name ||
                          om?.full_name ||
                          om?.email ||
                          null
                        setInstructionDialog({
                          channelKind: 'direct',
                          channelUserId: expandedUserId,
                          channelProjectId: null,
                          driverLabel: name,
                          projectLabel: null,
                        })
                      }}
                      className="w-full flex items-center justify-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
                      title="このドライバーに指示を送信"
                    >
                      <Send className="h-4 w-4" />
                      指示送信
                    </button>
                  </div>
                  {/* 3. ドライバー詳細 (運行履歴) — 指示送信の下 */}
                  <div className="border-t bg-slate-50/50">
                    <UserInlineDetail
                      key={expandedUserId}
                      userId={expandedUserId}
                      activeAssignment={
                        Array.from(activeAssignments.values()).find(
                          (a) => a.user_id === expandedUserId,
                        ) ?? null
                      }
                      selectedIds={selectedSectionAssignmentIds}
                      onSelectSectionsByDay={selectSectionsByDay}
                      onSelect={selectSection}
                      onDeleteSection={handleDeleteSection}
                      historyReloadKey={sectionHistoryTick}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {instructionDialog && (
        <MobilityInstructionDialog
          organizationId={orgId}
          presetChannelKind={instructionDialog.channelKind}
          presetChannelUserId={instructionDialog.channelUserId}
          presetChannelProjectId={instructionDialog.channelProjectId}
          presetDriverLabel={instructionDialog.driverLabel}
          presetProjectLabel={instructionDialog.projectLabel}
          presetPointId={instructionDialog.pointId ?? null}
          onClose={() => setInstructionDialog(null)}
        />
      )}

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

      {/* カテゴリ 関連ダイアログ */}
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
                `カテゴリ「${p?.name ?? ''}」を完全削除しますか?\nメンバー割当・ポイント・履歴も連鎖削除されます。`,
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
          onInstruct={() => {
            // 地図のポイント → 指示。行き先を埋めた状態でダイアログを開く
            setInstructionDialog({
              channelKind: 'direct',
              channelUserId: null,
              channelProjectId: null,
              driverLabel: null,
              projectLabel: null,
              pointId: editingPoint.id,
            })
            setEditingPoint(null)
          }}
          onSave={async (patch) => {
            await updatePoint(editingPoint.id, patch)
            void reloadAllProjectPoints()
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
              void reloadAllProjectPoints()
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


function VehicleRow({
  vehicle,
  active,
  activeAssignment,
  expanded,
  selectedIds,
  onToggleExpand,
  onSelect,
  onSelectSectionsByDay,
  onDeleteSection,
  historyReloadKey,
  onEdit,
}: {
  vehicle: Vehicle
  active: boolean
  activeAssignment: AssignmentWithNames | null
  expanded: boolean
  selectedIds: string[]
  onToggleExpand: () => void
  onSelect: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
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
          selectedIds={selectedIds}
      onSelectSectionsByDay={onSelectSectionsByDay}
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
  todayDistanceM: number
  distanceLabel: string
  selectedIds: string[]
  onSelect: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
  /** 削除ボタン用。null なら削除ボタンを出さない */
  onDeleteSection?: (assignmentId: string, label: string) => void
  /** 履歴の 1 行に何を「主タイトル」として出すか。車両詳細ならドライバー名、ユーザー詳細なら車両名 */
  primaryLabel: (a: AssignmentWithNames) => string
}

function InlineDetailBody({
  history,
  historyLoading,
  positionsByAssignment,
  todayDistanceM,
  distanceLabel,
  selectedIds,
  onSelect,
  onSelectSectionsByDay,
  onDeleteSection,
  primaryLabel,
}: HistoryDetailProps) {
  return (
    <div className="border-t bg-slate-50/60 p-3 space-y-3">
      {/* 走行距離。速度は地図のラベル (ドライバー / 車両 / 速度) に出すので
          ここには置かない (同じ値が 2 箇所にあると視線が散る) */}
      <div className="grid grid-cols-1 gap-2">
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
            日/セクションをタップ
          </span>
        </div>
        {history.length === 0 && !historyLoading ? (
          <div className="p-2 bg-white rounded border text-[11px] text-slate-400 text-center">
            履歴はありません
          </div>
        ) : (
          <DayGroupedHistory
            history={history}
            positionsByAssignment={positionsByAssignment}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onSelectSectionsByDay={onSelectSectionsByDay}
            onDeleteSection={onDeleteSection}
            primaryLabel={primaryLabel}
          />
        )}
      </div>
    </div>
  )
}

// 履歴を「日ごと」にまとめて表示。日ヘッダをクリックするとその日全部のセクションが
// 選択される (再クリックで解除)。セクション行のクリックは従来通り単選択。
function DayGroupedHistory({
  history,
  positionsByAssignment,
  selectedIds,
  onSelect,
  onSelectSectionsByDay,
  onDeleteSection,
  primaryLabel,
}: {
  history: AssignmentWithNames[]
  positionsByAssignment: Map<string, MobilityPosition[]>
  selectedIds: string[]
  onSelect: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
  onDeleteSection?: (assignmentId: string, label: string) => void
  primaryLabel: (a: AssignmentWithNames) => string
}) {
  // 日ラベル (今日 / 昨日 / M/D)
  const groupKey = (iso: string): string => {
    const d = new Date(iso)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const start = new Date(d)
    start.setHours(0, 0, 0, 0)
    if (start.getTime() === today.getTime()) return '今日'
    if (start.getTime() === yesterday.getTime()) return '昨日'
    return `${start.getMonth() + 1}/${start.getDate()}`
  }
  const grouped = useMemo(() => {
    const map = new Map<string, AssignmentWithNames[]>()
    for (const a of history) {
      const k = groupKey(a.started_at)
      const arr = map.get(k)
      if (arr) arr.push(a)
      else map.set(k, [a])
    }
    return Array.from(map.entries())
  }, [history])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const [expandedDays, setExpandedDays] = useState<Set<string>>(
    () => new Set(['今日']),
  )
  const toggleDay = (day: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

  const dayAllSelected = (dayIds: string[]) =>
    dayIds.length > 0 && dayIds.every((id) => selectedSet.has(id))
  const daySomeSelected = (dayIds: string[]) =>
    dayIds.some((id) => selectedSet.has(id))

  // 日ごとの合計走行距離
  const dayTotalKm = (dayIds: string[]) => {
    let m = 0
    for (const id of dayIds) {
      const rows = positionsByAssignment.get(id)
      if (rows) m += computeTotalDistanceMeters(rows)
    }
    return m / 1000
  }

  return (
    <div className="space-y-1.5">
      {grouped.map(([day, rows]) => {
        const dayIds = rows.map((a) => a.id)
        const isDayAll = dayAllSelected(dayIds)
        const isDaySome = !isDayAll && daySomeSelected(dayIds)
        const dayKm = dayTotalKm(dayIds)
        const isExpanded = expandedDays.has(day)
        return (
          <div key={day} className="rounded border overflow-hidden bg-white">
            {/* 日ヘッダ */}
            <div
              className={`flex items-center border-b ${
                isDayAll
                  ? 'bg-indigo-100 border-indigo-300'
                  : isDaySome
                    ? 'bg-indigo-50'
                    : 'bg-slate-50'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectSectionsByDay(dayIds)}
                className="flex-1 flex items-center gap-2 px-2.5 py-1.5 text-left"
                title={
                  isDayAll
                    ? 'クリックでこの日の選択を全解除'
                    : 'クリックでこの日 1 日分の軌跡を地図に表示'
                }
              >
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm shrink-0 border ${
                    isDayAll
                      ? 'bg-indigo-600 border-indigo-700'
                      : isDaySome
                        ? 'bg-indigo-300 border-indigo-500'
                        : 'bg-white border-slate-400'
                  }`}
                />
                <span
                  className={`text-xs font-semibold flex-1 ${
                    isDayAll ? 'text-indigo-900' : 'text-slate-700'
                  }`}
                >
                  {day}
                </span>
                <span className="text-[10px] text-slate-500 shrink-0">
                  {rows.length} 回 · {dayKm.toFixed(1)} km
                </span>
              </button>
              <button
                type="button"
                onClick={() => toggleDay(day)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
                title={isExpanded ? '折りたたむ' : '内訳を表示'}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>
            </div>
            {/* セクション明細 */}
            {isExpanded && (
              <ul className="divide-y">
                {rows.map((a) => {
                  const isSelected = selectedSet.has(a.id)
                  const posRows = positionsByAssignment.get(a.id)
                  const distanceKm = posRows
                    ? computeTotalDistanceMeters(posRows) / 1000
                    : null
                  return (
                    <li
                      key={a.id}
                      className={`flex items-center text-[11px] transition ${
                        isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(a.id)}
                        className="flex-1 flex items-center gap-2 px-2.5 py-1.5 text-left min-w-0"
                        title={
                          isSelected
                            ? '選択中 (もう一度クリックで解除)'
                            : 'クリックでこのセクションだけを表示'
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
                              : 'font-medium text-slate-700'
                          }`}
                        >
                          {primaryLabel(a)}
                        </span>
                        <span className="text-slate-500 shrink-0">
                          {new Date(a.started_at).toLocaleTimeString('ja-JP', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {a.ended_at ? (
                            <>
                              {' 〜 '}
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
                          {distanceKm != null
                            ? `${distanceKm.toFixed(1)}km`
                            : '—'}
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
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 shrink-0"
                          title="このセクションを削除 (位置ログも消える)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function VehicleInlineDetail({
  vehicleId,
  activeAssignment,
  selectedIds,
  onSelect,
  onSelectSectionsByDay,
  onDeleteSection,
  historyReloadKey,
}: {
  vehicleId: string
  activeAssignment: AssignmentWithNames | null
  selectedIds: string[]
  onSelect: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
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


  return (
    <InlineDetailBody
      history={history}
      historyLoading={historyLoading}
      positionsByAssignment={positionsByAssignment}
      vehiclesById={vehiclesById}
      todayDistanceM={todayDistanceM}
      distanceLabel="本日走行 (この車両)"
      selectedIds={selectedIds}
      onSelectSectionsByDay={onSelectSectionsByDay}
      onSelect={onSelect}
      onDeleteSection={onDeleteSection}
      primaryLabel={(a) => a.driver_name || '(名前未設定)'}
    />
  )
}

function UserInlineDetail({
  userId,
  activeAssignment,
  selectedIds,
  onSelect,
  onSelectSectionsByDay,
  onDeleteSection,
  historyReloadKey,
}: {
  userId: string
  activeAssignment: AssignmentWithNames | null
  selectedIds: string[]
  onSelect: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
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


  return (
    <InlineDetailBody
      history={history}
      historyLoading={historyLoading}
      positionsByAssignment={positionsByAssignment}
      vehiclesById={vehiclesById}
      todayDistanceM={todayDistanceM}
      distanceLabel="本日走行 (この人)"
      selectedIds={selectedIds}
      onSelectSectionsByDay={onSelectSectionsByDay}
      onSelect={onSelect}
      onDeleteSection={onDeleteSection}
      primaryLabel={(a) => vehiclesById.get(a.vehicle_id)?.name ?? '(不明車両)'}
    />
  )
}

// -----------------------------------------------------------------------------
// カテゴリ 左サイドパネル
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
          カテゴリ ({projects.length})
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
          カテゴリがありません。「新規」から作成してください。
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

          {/* メッセージは admin↔driver の direct のみに変更したので
              現場メンバー全員宛ての指示 / 現場チャットは撤去 */}
        </div>
      )}
    </li>
  )
}

// -----------------------------------------------------------------------------
// カテゴリダイアログ (作成 / 編集 / メンバー追加 / ポイント編集)
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
  onInstruct,
  onClose,
}: {
  point: MobilityProjectPoint
  onSave: (patch: {
    name: string
    memo: string | null
  }) => Promise<void>
  /** このポイントを行き先にして指示を送る */
  onInstruct: () => void
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
        {/* 地図のポイントから「ここへ向かうよう指示」へ直行できるようにする。
            編集より指示の方が使用頻度が高いので上に置く */}
        <div className="px-4 pb-1">
          <button
            onClick={onInstruct}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700"
          >
            <Send className="h-4 w-4" />
            このポイントへ向かうよう指示
          </button>
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

// -----------------------------------------------------------------------------
// 車両・ユーザー統合サイドバー (左)
//   - 稼働中: ユーザー+車両のペアカードを上に (くっつけて表示)
//   - 稼働していないユーザー: 下段に (組織メンバー全体)
//   - 稼働していない車両: さらに下段に
// -----------------------------------------------------------------------------
interface FleetSidebarProps {
  organizationId: string
  activeAssignments: Map<string, AssignmentWithNames>
  vehicles: Vehicle[]
  orgMembers: OrgMemberRow[]
  loading: boolean
  expandedUserId: string | null
  expandedVehicleId: string | null
  selectedSectionAssignmentIds: string[]
  ageMsForAssignment: (assignmentId: string) => number | null
  staleThresholdMs: number
  forceLeaveBusyId: string | null
  sectionHistoryTick: number
  onToggleExpandUser: (userId: string) => void
  onToggleExpandVehicle: (vehicleId: string) => void
  onSelectSection: (assignmentId: string) => void
  onSelectSectionsByDay: (assignmentIds: string[]) => void
  onDeleteSection: (assignmentId: string, label: string) => void
  onForceLeave: (
    assignmentId: string,
    driverName: string | null,
    vehicleName: string,
  ) => Promise<void>
  onEditVehicle: (v: Vehicle) => void
  onNewVehicle: () => void
  onInviteByPhone: () => void
  /** 指定ドライバーへの指示送信ダイアログを開く */
  onOpenInstructionForDriver: (userId: string, driverName: string | null) => void
}

// ユーザー列: 稼働中ペア (上) + 未乗車ユーザー (下)
function UsersColumn(props: FleetSidebarProps) {
  const {
    activeAssignments,
    vehicles,
    orgMembers,
    loading,
    expandedUserId,
    ageMsForAssignment,
    staleThresholdMs,
    forceLeaveBusyId,
    onToggleExpandUser,
    onForceLeave,
    onInviteByPhone,
  } = props

  const memberByUserId = useMemo(() => {
    const m = new Map<string, OrgMemberRow>()
    for (const r of orgMembers) m.set(r.user_id, r)
    return m
  }, [orgMembers])

  const activePairs = useMemo(() => {
    const rows: {
      assignment: AssignmentWithNames
      vehicle: Vehicle | null
      userInfo: OrgMemberRow | null
    }[] = []
    for (const [vid, a] of activeAssignments) {
      rows.push({
        assignment: a,
        vehicle: vehicles.find((v) => v.id === vid) ?? null,
        userInfo: memberByUserId.get(a.user_id) ?? null,
      })
    }
    rows.sort((x, y) =>
      (x.assignment.driver_name ?? '').localeCompare(y.assignment.driver_name ?? ''),
    )
    return rows
  }, [activeAssignments, vehicles, memberByUserId])

  const activeUserIds = useMemo(
    () => new Set(activePairs.map((p) => p.assignment.user_id)),
    [activePairs],
  )
  const inactiveUsers = useMemo(
    () => orgMembers.filter((m) => !activeUserIds.has(m.user_id)),
    [orgMembers, activeUserIds],
  )

  const totalDrivers = activePairs.length + inactiveUsers.length
  return (
    <div className="space-y-3">
      {/* 親タイトル: ドライバー (合計) */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-5 rounded bg-indigo-500" />
        <h2 className="text-sm font-semibold text-slate-700 flex-1">
          ドライバー ({totalDrivers})
        </h2>
        {PHONE_INVITE_ENABLED && (
          <button
            type="button"
            onClick={onInviteByPhone}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
            title="電話番号でドライバーを招待する"
          >
            <Phone className="h-3 w-3" />
            招待
          </button>
        )}
      </div>

      {/* 稼働中ペア */}
      {activePairs.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1.5 pl-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <h3 className="text-xs font-medium text-slate-500">
              稼働中 ({activePairs.length})
            </h3>
          </div>
          <ul className="space-y-2">
            {activePairs.map(({ assignment, vehicle, userInfo }) => (
              <ActivePairCard
                key={assignment.id}
                assignment={assignment}
                vehicle={vehicle}
                userInfo={userInfo}
                expanded={expandedUserId === assignment.user_id}
                ageMs={ageMsForAssignment(assignment.id)}
                staleThresholdMs={staleThresholdMs}
                forceLeaveBusyId={forceLeaveBusyId}
                onToggleExpand={() => onToggleExpandUser(assignment.user_id)}
                onForceLeave={() =>
                  onForceLeave(
                    assignment.id,
                    assignment.driver_name,
                    vehicle?.name ?? '(不明車両)',
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}

      {/* 待機中ユーザー */}
      <section>
        <div className="flex items-center gap-2 mb-1.5 pl-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400" />
          <h3 className="text-xs font-medium text-slate-500">
            待機中 ({inactiveUsers.length})
          </h3>
        </div>
        {loading ? (
          <div className="p-4 text-center text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            読み込み中...
          </div>
        ) : inactiveUsers.length === 0 ? (
          <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
            全員乗車中 or メンバー未登録
          </div>
        ) : (
          <ul className="space-y-1.5">
            {inactiveUsers.map((m) => (
              <InactiveUserCard
                key={m.user_id}
                member={m}
                expanded={expandedUserId === m.user_id}
                onToggleExpand={() => onToggleExpandUser(m.user_id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// 車両列: 稼働中車両 (ドライバー付き) + 未使用車両 + 廃止済み車両
function VehiclesColumn(props: FleetSidebarProps) {
  const {
    activeAssignments,
    vehicles,
    expandedVehicleId,
    selectedSectionAssignmentIds,
    sectionHistoryTick,
    onToggleExpandVehicle,
    onSelectSection,
    onSelectSectionsByDay,
    onDeleteSection,
    onEditVehicle,
    onNewVehicle,
  } = props

  const activeVehicles = useMemo(() => {
    const rows: { vehicle: Vehicle; assignment: AssignmentWithNames }[] = []
    for (const [vid, a] of activeAssignments) {
      const v = vehicles.find((x) => x.id === vid)
      if (v) rows.push({ vehicle: v, assignment: a })
    }
    rows.sort((x, y) => x.vehicle.name.localeCompare(y.vehicle.name))
    return rows
  }, [activeAssignments, vehicles])

  const activeVehicleIds = useMemo(
    () => new Set(activeVehicles.map((r) => r.vehicle.id)),
    [activeVehicles],
  )
  const availableVehicles = useMemo(
    () => vehicles.filter((v) => v.active && !activeVehicleIds.has(v.id)),
    [vehicles, activeVehicleIds],
  )
  const retiredVehicles = useMemo(
    () => vehicles.filter((v) => !v.active),
    [vehicles],
  )

  const totalVehicles =
    activeVehicles.length + availableVehicles.length + retiredVehicles.length
  return (
    <div className="space-y-3">
      {/* 親タイトル: 車両 (合計) */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-5 rounded bg-indigo-500" />
        <h2 className="text-sm font-semibold text-slate-700 flex-1">
          車両 ({totalVehicles})
        </h2>
        <button
          type="button"
          onClick={onNewVehicle}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
        >
          <Plus className="h-3 w-3" />
          新規
        </button>
      </div>

      {/* 稼働中車両 */}
      {activeVehicles.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1.5 pl-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <h3 className="text-xs font-medium text-slate-500">
              稼働中 ({activeVehicles.length})
            </h3>
          </div>
          <ul className="space-y-1.5">
            {activeVehicles.map(({ vehicle, assignment }) => (
              <VehicleRow
                key={vehicle.id}
                vehicle={vehicle}
                active={true}
                activeAssignment={assignment}
                expanded={expandedVehicleId === vehicle.id}
                selectedIds={selectedSectionAssignmentIds}
                onSelectSectionsByDay={onSelectSectionsByDay}
                onToggleExpand={() => onToggleExpandVehicle(vehicle.id)}
                onSelect={onSelectSection}
                onDeleteSection={onDeleteSection}
                historyReloadKey={sectionHistoryTick}
                onEdit={() => onEditVehicle(vehicle)}
              />
            ))}
          </ul>
        </section>
      )}

      {/* 待機中車両 */}
      <section>
        <div className="flex items-center gap-2 mb-1.5 pl-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400" />
          <h3 className="text-xs font-medium text-slate-500">
            待機中 ({availableVehicles.length})
          </h3>
        </div>
        {availableVehicles.length === 0 ? (
          <div className="p-3 bg-white rounded border text-xs text-slate-400 text-center">
            未登録 or 全車両稼働中
          </div>
        ) : (
          <ul className="space-y-1.5">
            {availableVehicles.map((v) => (
              <VehicleRow
                key={v.id}
                vehicle={v}
                active={false}
                activeAssignment={null}
                expanded={expandedVehicleId === v.id}
                selectedIds={selectedSectionAssignmentIds}
                onSelectSectionsByDay={onSelectSectionsByDay}
                onToggleExpand={() => onToggleExpandVehicle(v.id)}
                onSelect={onSelectSection}
                onDeleteSection={onDeleteSection}
                historyReloadKey={sectionHistoryTick}
                onEdit={() => onEditVehicle(v)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* 廃止済み車両 */}
      {retiredVehicles.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1.5 pl-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-300" />
            <h3 className="text-xs font-medium text-slate-500">
              廃止済み ({retiredVehicles.length})
            </h3>
          </div>
          <ul className="space-y-1.5 opacity-60">
            {retiredVehicles.map((v) => (
              <VehicleRow
                key={v.id}
                vehicle={v}
                active={false}
                activeAssignment={null}
                expanded={expandedVehicleId === v.id}
                selectedIds={selectedSectionAssignmentIds}
                onSelectSectionsByDay={onSelectSectionsByDay}
                onToggleExpand={() => onToggleExpandVehicle(v.id)}
                onSelect={onSelectSection}
                onDeleteSection={onDeleteSection}
                historyReloadKey={sectionHistoryTick}
                onEdit={() => onEditVehicle(v)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// 稼働中ペアカード: ユーザー行 + 車両行を 1 枚のカードにまとめる
function ActivePairCard({
  assignment,
  vehicle,
  userInfo,
  expanded,
  ageMs,
  staleThresholdMs,
  forceLeaveBusyId,
  onToggleExpand,
  onForceLeave,
}: {
  assignment: AssignmentWithNames
  vehicle: Vehicle | null
  userInfo: OrgMemberRow | null
  expanded: boolean
  ageMs: number | null
  staleThresholdMs: number
  forceLeaveBusyId: string | null
  onToggleExpand: () => void
  onForceLeave: () => void
}) {
  const noPositionsYet = ageMs == null
  const stale = ageMs != null && ageMs > staleThresholdMs
  const VIcon = vehicle ? KIND_ICON[vehicle.kind] : Car
  return (
    <li
      className={`bg-white rounded border ${
        expanded
          ? 'ring-1 ring-indigo-500 border-indigo-400'
          : 'hover:border-indigo-400'
      }`}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full text-left"
      >
        {/* User + Vehicle 横並び (glued with border-l on vehicle) */}
        <div className="flex items-stretch">
          {/* User part */}
          <div className="flex items-center gap-2 p-2 flex-1 min-w-0">
            <div className="h-7 w-7 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <User className="h-3.5 w-3.5 text-emerald-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-800 truncate">
                {assignment.driver_name || userInfo?.email || '(名前未設定)'}
              </div>
              {userInfo?.email && assignment.driver_name && (
                <div className="text-[10px] text-slate-500 truncate">
                  {userInfo.email}
                </div>
              )}
            </div>
          </div>
          {/* Vehicle part (右側にくっつけて) */}
          <div className="flex items-center gap-2 p-2 flex-1 min-w-0 border-l bg-slate-50/60">
            <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <VIcon className="h-3.5 w-3.5 text-indigo-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-slate-700 truncate">
                {vehicle?.name ?? '(不明車両)'}
                {vehicle?.plate_or_serial && (
                  <span className="text-slate-400 ml-1 font-normal">
                    ({vehicle.plate_or_serial})
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-500 truncate">
                {vehicle && KIND_LABEL[vehicle.kind]} ·{' '}
                {new Date(assignment.started_at).toLocaleString('ja-JP', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                〜
              </div>
            </div>
          </div>
          {/* Chevron 右端 */}
          <div className="flex items-center pr-2">
            <ChevronDown
              className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </div>
        </div>
        {/* ステータスバッジ + 行き先 (カード下部) */}
        <div className="flex items-center flex-wrap gap-1.5 px-2 pb-1.5">
          {noPositionsYet ? (
            <span
              className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 border border-amber-300"
              title="このセッション中に位置ログを 1 件も受け取っていません。ドライバー端末の自動送信 ON を確認してください。"
            >
              📡 位置未受信
            </span>
          ) : stale ? (
            <span
              className="px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 border border-red-300"
              title={ageMs != null ? `最終 ping から ${formatAgeShort(ageMs)}` : ''}
            >
              ⚠ 通信断 {ageMs != null && formatAgeShort(ageMs)}
            </span>
          ) : (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
              乗車中
            </span>
          )}
          {assignment.destination_point && (
            <span className="text-[10px] text-amber-700 flex items-center gap-1 truncate">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">
                行き先: {assignment.destination_point.name}
              </span>
            </span>
          )}
        </div>
      </button>
      {/* 強制降車 (指示送信 と 運行履歴 は地図右パネルに移動済) */}
      <div className="px-3 pb-2 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onForceLeave()
          }}
          disabled={forceLeaveBusyId === assignment.id}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
          title="管理者権限で降車させる"
        >
          {forceLeaveBusyId === assignment.id ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <LogOut className="h-3 w-3" />
          )}
          強制降車
        </button>
      </div>
    </li>
  )
}

// 未乗車ユーザーカード
function InactiveUserCard({
  member,
  expanded,
  onToggleExpand,
}: {
  member: OrgMemberRow
  expanded: boolean
  onToggleExpand: () => void
}) {
  return (
    <li
      className={`bg-white rounded border ${
        expanded
          ? 'ring-1 ring-indigo-500 border-indigo-400'
          : 'hover:border-indigo-400'
      }`}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full flex items-center gap-2 p-2.5 text-left"
      >
        <div className="h-7 w-7 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
          <User className="h-3.5 w-3.5 text-slate-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-800 truncate">
            {member.full_name || member.email}
          </div>
          {member.full_name && member.email !== member.full_name && (
            <div className="text-[10px] text-slate-500 truncate">
              {member.email}
            </div>
          )}
        </div>
        {member.role === 'admin' && (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800">
            管理者
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 text-slate-400 shrink-0 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {/* 展開時の詳細 (指示送信 / 運行履歴 / チャット) は地図の右パネルに移動済 */}
    </li>
  )
}
