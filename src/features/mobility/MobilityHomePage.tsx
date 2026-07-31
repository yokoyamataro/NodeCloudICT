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

import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar,
  Car,
  Construction,
  Folder,
  Loader2,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Truck,
  User,
  X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCanManageMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type { Vehicle, VehicleKind } from '@/types/database'
import { FleetMapView } from '@/features/mobility/FleetMapView'
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
  } = useMobilityStore()

  useEffect(() => {
    if (!orgId) return
    void fetchVehicles(orgId)
    void fetchActiveAssignments(orgId)
  }, [orgId, fetchVehicles, fetchActiveAssignments])

  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null)
  const [mode, setMode] = useState<'vehicle' | 'user'>('vehicle')
  const [orgMembers, setOrgMembers] = useState<OrgMemberRow[]>([])
  const [orgMembersLoading, setOrgMembersLoading] = useState(false)
  const [showPhoneInvite, setShowPhoneInvite] = useState(false)

  // ユーザー一覧を取得 (user モード時)
  useEffect(() => {
    if (!orgId || mode !== 'user') return
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
  }, [orgId, mode])

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
        onOpenProjects={() => navigate('/mobility/projects')}
      />

      {vehiclesError && (
        <div className="mx-4 mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {vehiclesError}
        </div>
      )}

      {/* PC は左に地図 + 右に車両パネル。画面幅が狭い時 (< lg) は上下配置 */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* 地図エリア */}
        <div className="h-64 lg:h-auto lg:flex-1 relative border-b lg:border-b-0 lg:border-r">
          <FleetMapView
            organizationId={orgId}
            onSelectVehicle={(vid) => navigate(`/mobility/vehicles/${vid}`)}
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
            onOpenUser={(userId) => navigate(`/mobility/users/${userId}`)}
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
                return (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 p-3 bg-white rounded border hover:border-indigo-400 cursor-pointer"
                    onClick={() => navigate(`/mobility/vehicles/${v.id}`)}
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
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                      稼働中
                    </span>
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
                    onOpen={() => navigate(`/mobility/vehicles/${v.id}`)}
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
                        onOpen={() => navigate(`/mobility/vehicles/${v.id}`)}
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
    </div>
  )
}

function MobilityHeader({
  onBack,
  onOpenLogs,
  onOpenProjects,
}: {
  onBack: () => void
  onOpenLogs?: () => void
  onOpenProjects?: () => void
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
      {onOpenProjects && (
        <button
          onClick={onOpenProjects}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
          title="運行現場を管理"
        >
          <Folder className="h-4 w-4" />
          運行現場
        </button>
      )}
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
  onOpenUser,
  onInviteByPhone,
}: {
  activeAssignments: Map<
    string,
    {
      id: string
      user_id: string
      vehicle_id: string
      driver_name: string | null
      started_at: string
      destination_point?: { id: string; name: string } | null
    }
  >
  vehicles: Vehicle[]
  orgMembers: OrgMemberRow[]
  loading: boolean
  onOpenUser: (userId: string) => void
  onInviteByPhone: () => void
}) {
  const activeUsers = useMemo(() => {
    const rows: {
      userId: string
      driverName: string
      vehicleName: string
      startedAt: string
      destinationName: string | null
    }[] = []
    for (const a of activeAssignments.values()) {
      const v = vehicles.find((vv) => vv.id === a.vehicle_id)
      rows.push({
        userId: a.user_id,
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
            {activeUsers.map((u) => (
              <li
                key={u.userId}
                className="flex items-center gap-3 p-3 bg-white rounded border hover:border-indigo-400 cursor-pointer"
                onClick={() => onOpenUser(u.userId)}
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
                <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                  乗車中
                </span>
              </li>
            ))}
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
              return (
                <li
                  key={m.user_id}
                  className="flex items-center gap-2 p-2.5 bg-white rounded border hover:border-indigo-400 cursor-pointer"
                  onClick={() => onOpenUser(m.user_id)}
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
  onOpen,
  onEdit,
}: {
  vehicle: Vehicle
  active: boolean
  onOpen: () => void
  onEdit: () => void
}) {
  const Icon = KIND_ICON[vehicle.kind]
  return (
    <li className="flex items-center gap-2 p-3 bg-white rounded border hover:border-indigo-400">
      <button
        type="button"
        onClick={onOpen}
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
