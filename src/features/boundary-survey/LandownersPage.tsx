// 地籍測量: 地権者管理ページ。
// /boundary-survey/landowners
//
// ・現工区の地権者を一覧し、新規追加 / 編集 / 削除できる
// ・各地権者には氏名・郵便・住所・電話・代理人情報・立会日時・通知方法・立会状況

import { useEffect, useMemo, useState } from 'react'
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Save,
  X,
  Users,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import {
  useLandownerStore,
  type LandownerEditableFields,
} from '@/stores/landownerStore'
import type {
  Landowner,
  LandownerAttendanceStatus,
  LandownerNotificationMethod,
} from '@/types/database'
import {
  LANDOWNER_ATTENDANCE_LABEL,
  LANDOWNER_NOTIFICATION_LABEL,
} from '@/types/database'

const ATTENDANCE_OPTIONS: LandownerAttendanceStatus[] = [
  'not_attended',
  'field_confirmed',
  'document_confirmed',
  'rejected',
]

const NOTIFICATION_OPTIONS: LandownerNotificationMethod[] = [
  'direct_visit',
  'mail',
  'phone',
  'agent',
]

const STATUS_BADGE: Record<LandownerAttendanceStatus, string> = {
  not_attended: 'bg-slate-100 text-slate-600 border-slate-200',
  field_confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  document_confirmed: 'bg-blue-50 text-blue-700 border-blue-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
}

function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(s: string): string | null {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

const emptyDraft = (): LandownerEditableFields => ({
  full_name: '',
  postal_code: null,
  address: null,
  phone: null,
  agent_name: null,
  agent_address: null,
  agent_phone: null,
  agent_relation: null,
  primary_attendance_at: null,
  secondary_attendance_at: null,
  notification_method: null,
  attendance_status: 'not_attended',
  notes: null,
})

export function LandownersPage() {
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null

  const landowners = useLandownerStore((s) => s.landowners)
  const loading = useLandownerStore((s) => s.loading)
  const fetchByFarm = useLandownerStore((s) => s.fetchByFarm)
  const createLandowner = useLandownerStore((s) => s.createLandowner)
  const updateLandowner = useLandownerStore((s) => s.updateLandowner)
  const deleteLandowner = useLandownerStore((s) => s.deleteLandowner)
  const error = useLandownerStore((s) => s.error)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<LandownerEditableFields>(emptyDraft())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  const visible = useMemo(() => {
    if (!filter) return landowners
    const lc = filter.toLowerCase()
    return landowners.filter(
      (l) =>
        l.full_name.toLowerCase().includes(lc) ||
        (l.address ?? '').toLowerCase().includes(lc) ||
        (l.agent_name ?? '').toLowerCase().includes(lc),
    )
  }, [landowners, filter])

  const openNew = () => {
    setCreating(true)
    setEditingId(null)
    setDraft(emptyDraft())
    setFormError(null)
  }

  const openEdit = (lo: Landowner) => {
    setEditingId(lo.id)
    setCreating(false)
    setDraft({
      full_name: lo.full_name,
      postal_code: lo.postal_code,
      address: lo.address,
      phone: lo.phone,
      agent_name: lo.agent_name,
      agent_address: lo.agent_address,
      agent_phone: lo.agent_phone,
      agent_relation: lo.agent_relation,
      primary_attendance_at: lo.primary_attendance_at,
      secondary_attendance_at: lo.secondary_attendance_at,
      notification_method: lo.notification_method,
      attendance_status: lo.attendance_status,
      notes: lo.notes,
    })
    setFormError(null)
  }

  const closeForm = () => {
    setCreating(false)
    setEditingId(null)
    setDraft(emptyDraft())
    setFormError(null)
  }

  const handleSave = async () => {
    setFormError(null)
    if (!draft.full_name.trim()) {
      setFormError('氏名を入力してください')
      return
    }
    if (!farmId) {
      setFormError('工区が選択されていません')
      return
    }
    setSaving(true)
    try {
      if (creating) {
        const created = await createLandowner(farmId, { ...draft, full_name: draft.full_name.trim() })
        if (!created) {
          setFormError(error ?? '作成に失敗しました')
          return
        }
      } else if (editingId) {
        await updateLandowner(editingId, { ...draft, full_name: draft.full_name.trim() })
      }
      closeForm()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (lo: Landowner) => {
    if (
      !confirm(
        `地権者「${lo.full_name}」を削除しますか？\n紐づいた地番への割当も同時に解除されます。`,
      )
    ) {
      return
    }
    await deleteLandowner(lo.id)
  }

  if (!farmId) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="地権者管理" subtitle="工区を選択してください" />
      </div>
    )
  }

  const isFormOpen = creating || editingId !== null

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="地権者管理"
        subtitle="工区に登録した地権者を一覧・編集します"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="氏名 / 住所 / 代理人で絞り込み"
              className="px-2 py-1 text-sm border rounded w-60"
            />
            <button
              onClick={openNew}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              地権者を追加
            </button>
          </div>
        }
      />

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {loading && landowners.length === 0 ? (
          <div className="flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {landowners.length === 0
              ? '地権者がまだ登録されていません。「地権者を追加」から登録してください。'
              : '該当する地権者がいません'}
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">氏名</th>
                  <th className="text-left px-3 py-2 w-44">住所</th>
                  <th className="text-left px-3 py-2 w-32">電話番号</th>
                  <th className="text-left px-3 py-2 w-28">代理人氏名</th>
                  <th className="text-left px-3 py-2 w-40">一次立会日時</th>
                  <th className="text-left px-3 py-2 w-40">二次立会日時</th>
                  <th className="text-left px-3 py-2 w-24">通知</th>
                  <th className="text-left px-3 py-2 w-32">立会状況</th>
                  <th className="text-left px-3 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((lo) => (
                  <tr key={lo.id} className="border-t hover:bg-slate-50/50">
                    <td className="px-3 py-2 font-medium">{lo.full_name}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {lo.postal_code && <span className="mr-1">〒{lo.postal_code}</span>}
                      {lo.address ?? '-'}
                    </td>
                    <td className="px-3 py-2 text-xs">{lo.phone ?? '-'}</td>
                    <td className="px-3 py-2 text-xs">{lo.agent_name ?? '-'}</td>
                    <td className="px-3 py-2 text-xs">
                      {lo.primary_attendance_at
                        ? new Date(lo.primary_attendance_at).toLocaleString('ja-JP')
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {lo.secondary_attendance_at
                        ? new Date(lo.secondary_attendance_at).toLocaleString('ja-JP')
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {lo.notification_method
                        ? LANDOWNER_NOTIFICATION_LABEL[lo.notification_method]
                        : '-'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 text-[11px] rounded border ${STATUS_BADGE[lo.attendance_status]}`}
                      >
                        {LANDOWNER_ATTENDANCE_LABEL[lo.attendance_status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(lo)}
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                          title="編集"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(lo)}
                          className="p-1 text-red-500 hover:bg-red-50 rounded"
                          title="削除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isFormOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
          onClick={closeForm}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-600" />
              <h3 className="flex-1 text-base font-semibold">
                {creating ? '地権者を追加' : '地権者を編集'}
              </h3>
              <button
                onClick={closeForm}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3">
              <Field label="氏名 *">
                <input
                  type="text"
                  autoFocus
                  value={draft.full_name}
                  onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="郵便番号">
                  <input
                    type="text"
                    value={draft.postal_code ?? ''}
                    onChange={(e) => setDraft({ ...draft, postal_code: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                    placeholder="123-4567"
                  />
                </Field>
                <div className="col-span-2">
                  <Field label="住所">
                    <input
                      type="text"
                      value={draft.address ?? ''}
                      onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    />
                  </Field>
                </div>
              </div>
              <Field label="電話番号">
                <input
                  type="text"
                  value={draft.phone ?? ''}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                />
              </Field>

              <div className="border-t pt-3 space-y-3">
                <div className="text-xs font-semibold text-slate-600">代理人情報（任意）</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="代理人氏名">
                    <input
                      type="text"
                      value={draft.agent_name ?? ''}
                      onChange={(e) => setDraft({ ...draft, agent_name: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    />
                  </Field>
                  <Field label="代理人続柄">
                    <input
                      type="text"
                      value={draft.agent_relation ?? ''}
                      onChange={(e) => setDraft({ ...draft, agent_relation: e.target.value })}
                      placeholder="例: 長男 / 兄"
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    />
                  </Field>
                </div>
                <Field label="代理人住所">
                  <input
                    type="text"
                    value={draft.agent_address ?? ''}
                    onChange={(e) => setDraft({ ...draft, agent_address: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  />
                </Field>
                <Field label="代理人電話番号">
                  <input
                    type="text"
                    value={draft.agent_phone ?? ''}
                    onChange={(e) => setDraft({ ...draft, agent_phone: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  />
                </Field>
              </div>

              <div className="border-t pt-3 space-y-3">
                <div className="text-xs font-semibold text-slate-600">立会・連絡</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="一次立会日時">
                    <input
                      type="datetime-local"
                      value={toLocalInput(draft.primary_attendance_at)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          primary_attendance_at: fromLocalInput(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    />
                  </Field>
                  <Field label="二次立会日時">
                    <input
                      type="datetime-local"
                      value={toLocalInput(draft.secondary_attendance_at)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          secondary_attendance_at: fromLocalInput(e.target.value),
                        })
                      }
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="通知方法">
                    <select
                      value={draft.notification_method ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notification_method:
                            (e.target.value as LandownerNotificationMethod) || null,
                        })
                      }
                      className="w-full px-2 py-1.5 text-sm border rounded bg-white"
                    >
                      <option value="">未設定</option>
                      {NOTIFICATION_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {LANDOWNER_NOTIFICATION_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="立会状況">
                    <select
                      value={draft.attendance_status}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          attendance_status: e.target.value as LandownerAttendanceStatus,
                        })
                      }
                      className="w-full px-2 py-1.5 text-sm border rounded bg-white"
                    >
                      {ATTENDANCE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {LANDOWNER_ATTENDANCE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>

              <Field label="メモ">
                <textarea
                  value={draft.notes ?? ''}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1.5 text-sm border rounded resize-y"
                />
              </Field>

              {formError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {formError}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <button
                onClick={closeForm}
                disabled={saving}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !draft.full_name.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {creating ? '作成' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  )
}
