// 地権者一覧用: 1 行ぶんの inline 編集セル群と、行に揃うヘッダー。
// onBlur / onChange で updateLandowner を呼んで Supabase へ反映する。
// 表示する列は visibleColumns で絞れる（地番一覧と同じ仕組み）。

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useLandownerStore } from '@/stores/landownerStore'
import type {
  Landowner,
  LandownerAttendanceStatus,
  LandownerNotificationMethod,
} from '@/types/database'
import {
  LANDOWNER_ATTENDANCE_LABEL,
  LANDOWNER_NOTIFICATION_LABEL,
} from '@/types/database'

// 列の正準キー。表示順を兼ねる。
export const LANDOWNER_COLUMN_KEYS = [
  'full_name',
  'postal_code',
  'address',
  'phone',
  'agent_name',
  'agent_relation',
  'agent_address',
  'agent_phone',
  'primary_attendance_at',
  'secondary_attendance_at',
  'notification_method',
  'attendance_status',
  'notes',
] as const

export type LandownerColumnKey = (typeof LANDOWNER_COLUMN_KEYS)[number]

export const LANDOWNER_COLUMN_LABELS: Record<LandownerColumnKey, string> = {
  full_name: '氏名',
  postal_code: '郵便番号',
  address: '住所',
  phone: '電話番号',
  agent_name: '代理人氏名',
  agent_relation: '代理人続柄',
  agent_address: '代理人住所',
  agent_phone: '代理人電話番号',
  primary_attendance_at: '一次立会日時',
  secondary_attendance_at: '二次立会日時',
  notification_method: '通知方法',
  attendance_status: '立会状況',
  notes: 'メモ',
}

export const LANDOWNER_COLUMN_WIDTH: Record<LandownerColumnKey, string> = {
  full_name: 'w-32',
  postal_code: 'w-24',
  address: 'w-48',
  phone: 'w-32',
  agent_name: 'w-28',
  agent_relation: 'w-20',
  agent_address: 'w-40',
  agent_phone: 'w-32',
  primary_attendance_at: 'w-40',
  secondary_attendance_at: 'w-40',
  notification_method: 'w-24',
  attendance_status: 'w-32',
  notes: 'w-48',
}

// 既定で表示する列。詰めすぎないよう代理人住所 / 電話 / メモは初期非表示。
export const DEFAULT_VISIBLE_LANDOWNER_COLUMNS: ReadonlySet<LandownerColumnKey> = new Set([
  'full_name',
  'postal_code',
  'address',
  'phone',
  'agent_name',
  'agent_relation',
  'primary_attendance_at',
  'secondary_attendance_at',
  'notification_method',
  'attendance_status',
])

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
  not_attended: 'bg-slate-100 text-slate-700 border-slate-200',
  field_confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  document_confirmed: 'bg-blue-50 text-blue-700 border-blue-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
}

// timestamptz → datetime-local 文字列
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

const CELL_INPUT_CLASS =
  'w-full px-1.5 py-1 text-xs border-0 bg-transparent rounded hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-400 focus:outline-none'

interface RowProps {
  landowner: Landowner
  visibleColumns: ReadonlySet<LandownerColumnKey>
  onDelete: (landowner: Landowner) => void
}

export function LandownerRowFields({ landowner, visibleColumns, onDelete }: RowProps) {
  const updateLandowner = useLandownerStore((s) => s.updateLandowner)

  const [fullName, setFullName] = useState(landowner.full_name)
  const [postalCode, setPostalCode] = useState(landowner.postal_code ?? '')
  const [address, setAddress] = useState(landowner.address ?? '')
  const [phone, setPhone] = useState(landowner.phone ?? '')
  const [agentName, setAgentName] = useState(landowner.agent_name ?? '')
  const [agentRelation, setAgentRelation] = useState(landowner.agent_relation ?? '')
  const [agentAddress, setAgentAddress] = useState(landowner.agent_address ?? '')
  const [agentPhone, setAgentPhone] = useState(landowner.agent_phone ?? '')
  const [primaryAt, setPrimaryAt] = useState(toLocalInput(landowner.primary_attendance_at))
  const [secondaryAt, setSecondaryAt] = useState(
    toLocalInput(landowner.secondary_attendance_at),
  )
  const [notes, setNotes] = useState(landowner.notes ?? '')

  // 親の楽観更新で landowner オブジェクトが差し替わったらドラフトも同期
  useEffect(() => {
    setFullName(landowner.full_name)
    setPostalCode(landowner.postal_code ?? '')
    setAddress(landowner.address ?? '')
    setPhone(landowner.phone ?? '')
    setAgentName(landowner.agent_name ?? '')
    setAgentRelation(landowner.agent_relation ?? '')
    setAgentAddress(landowner.agent_address ?? '')
    setAgentPhone(landowner.agent_phone ?? '')
    setPrimaryAt(toLocalInput(landowner.primary_attendance_at))
    setSecondaryAt(toLocalInput(landowner.secondary_attendance_at))
    setNotes(landowner.notes ?? '')
  }, [landowner])

  const save = (patch: Partial<Landowner>) => {
    void updateLandowner(landowner.id, patch)
  }

  const renderCell = (key: LandownerColumnKey): React.ReactNode => {
    switch (key) {
      case 'full_name':
        return (
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={() => {
              const v = fullName.trim()
              if (!v) {
                // 氏名は必須。空なら元に戻す
                setFullName(landowner.full_name)
                return
              }
              if (v !== landowner.full_name) save({ full_name: v })
            }}
            className={`${CELL_INPUT_CLASS} font-medium`}
          />
        )
      case 'postal_code':
        return (
          <input
            type="text"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            onBlur={() => {
              const v = postalCode.trim() || null
              if (v !== landowner.postal_code) save({ postal_code: v })
            }}
            placeholder="123-4567"
            className={CELL_INPUT_CLASS}
          />
        )
      case 'address':
        return (
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => {
              const v = address.trim() || null
              if (v !== landowner.address) save({ address: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'phone':
        return (
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => {
              const v = phone.trim() || null
              if (v !== landowner.phone) save({ phone: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'agent_name':
        return (
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            onBlur={() => {
              const v = agentName.trim() || null
              if (v !== landowner.agent_name) save({ agent_name: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'agent_relation':
        return (
          <input
            type="text"
            value={agentRelation}
            onChange={(e) => setAgentRelation(e.target.value)}
            onBlur={() => {
              const v = agentRelation.trim() || null
              if (v !== landowner.agent_relation) save({ agent_relation: v })
            }}
            placeholder="長男 / 兄"
            className={CELL_INPUT_CLASS}
          />
        )
      case 'agent_address':
        return (
          <input
            type="text"
            value={agentAddress}
            onChange={(e) => setAgentAddress(e.target.value)}
            onBlur={() => {
              const v = agentAddress.trim() || null
              if (v !== landowner.agent_address) save({ agent_address: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'agent_phone':
        return (
          <input
            type="text"
            value={agentPhone}
            onChange={(e) => setAgentPhone(e.target.value)}
            onBlur={() => {
              const v = agentPhone.trim() || null
              if (v !== landowner.agent_phone) save({ agent_phone: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'primary_attendance_at':
        return (
          <input
            type="datetime-local"
            value={primaryAt}
            onChange={(e) => setPrimaryAt(e.target.value)}
            onBlur={() => {
              const v = fromLocalInput(primaryAt)
              if (v !== landowner.primary_attendance_at)
                save({ primary_attendance_at: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'secondary_attendance_at':
        return (
          <input
            type="datetime-local"
            value={secondaryAt}
            onChange={(e) => setSecondaryAt(e.target.value)}
            onBlur={() => {
              const v = fromLocalInput(secondaryAt)
              if (v !== landowner.secondary_attendance_at)
                save({ secondary_attendance_at: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
      case 'notification_method':
        return (
          <select
            value={landowner.notification_method ?? ''}
            onChange={(e) => {
              const v = (e.target.value as LandownerNotificationMethod) || null
              save({ notification_method: v })
            }}
            className={`${CELL_INPUT_CLASS} bg-white`}
          >
            <option value="">未設定</option>
            {NOTIFICATION_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {LANDOWNER_NOTIFICATION_LABEL[m]}
              </option>
            ))}
          </select>
        )
      case 'attendance_status':
        return (
          <select
            value={landowner.attendance_status}
            onChange={(e) =>
              save({ attendance_status: e.target.value as LandownerAttendanceStatus })
            }
            className={`w-full px-1.5 py-1 text-xs border rounded focus:ring-1 focus:ring-blue-400 focus:outline-none ${STATUS_BADGE[landowner.attendance_status]}`}
          >
            {ATTENDANCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {LANDOWNER_ATTENDANCE_LABEL[s]}
              </option>
            ))}
          </select>
        )
      case 'notes':
        return (
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              const v = notes.trim() || null
              if (v !== landowner.notes) save({ notes: v })
            }}
            className={CELL_INPUT_CLASS}
          />
        )
    }
  }

  return (
    <tr className="border-t hover:bg-slate-50/30">
      {LANDOWNER_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => (
        <td key={key} className={`px-1 py-1 align-middle ${LANDOWNER_COLUMN_WIDTH[key]}`}>
          {renderCell(key)}
        </td>
      ))}
      <td className="px-2 py-1 w-12 align-middle">
        <button
          onClick={() => onDelete(landowner)}
          className="p-1 text-red-500 hover:bg-red-50 rounded"
          title="削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}

interface HeaderProps {
  visibleColumns: ReadonlySet<LandownerColumnKey>
}

export function LandownerHeader({ visibleColumns }: HeaderProps) {
  return (
    <thead className="bg-slate-50 text-slate-600 text-xs sticky top-0 z-10">
      <tr>
        {LANDOWNER_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((k) => (
          <th key={k} className={`text-left px-2 py-2 font-medium ${LANDOWNER_COLUMN_WIDTH[k]}`}>
            {LANDOWNER_COLUMN_LABELS[k]}
          </th>
        ))}
        <th className="text-left px-2 py-2 w-12"></th>
      </tr>
    </thead>
  )
}
