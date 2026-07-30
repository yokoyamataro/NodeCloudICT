// モビリティ機能のホーム画面。
//
// 構成:
//   ・ヘッダ (戻るボタン、タイトル、開発中バッジ)
//   ・稼働中の車両サマリ (assignment.ended_at IS NULL の一覧)
//   ・車両マスタ一覧 (新規/編集/廃止/削除)
//
// 権限:
//   ・useCanUseMobility() で site owner のみ通す (未契約組織を弾く)
//   ・組織 admin のみ車両編集 (RLS 側でも二重ガードなので UI 判定は
//     楽観的に「所属組織があれば触れる」形で始めて、失敗時にサーバから戻す)

import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Car,
  Construction,
  Loader2,
  Map as MapIcon,
  Pencil,
  Plus,
  Trash2,
  Truck,
  User,
  X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useCanUseMobility } from '@/lib/useCanUseMobility'
import { useMobilityStore } from '@/stores/mobilityStore'
import type { Vehicle, VehicleKind } from '@/types/database'

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
  const canUse = useCanUseMobility()
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
    <div className="h-full flex flex-col bg-slate-50 overflow-auto">
      <MobilityHeader
        onBack={() => navigate('/')}
        onOpenMap={() => navigate('/mobility/map')}
      />

      {vehiclesError && (
        <div className="mx-4 mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {vehiclesError}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-5">
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
    </div>
  )
}

function MobilityHeader({
  onBack,
  onOpenMap,
}: {
  onBack: () => void
  onOpenMap?: () => void
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
      {onOpenMap && (
        <button
          onClick={onOpenMap}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
          title="稼働中車両を地図で見る"
        >
          <MapIcon className="h-4 w-4" />
          地図
        </button>
      )}
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
