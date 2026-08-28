// 指示送信ダイアログ (管理者用)
// - ドライバー個人 or 現場メンバー全員を宛先に選ぶ
// - 車両 (任意) + 行き先ポイント (必須) を指定
// - 補足メモを付ける

import { useEffect, useMemo, useState } from 'react'
import { Loader2, X, Send, Car, MapPin, User, FolderKanban } from 'lucide-react'
import { useMobilityStore } from '@/stores/mobilityStore'
import { useMobilityMessagesStore } from '@/stores/mobilityMessagesStore'
import { supabase } from '@/lib/supabase'
import type { MobilityProject, MobilityProjectPoint } from '@/types/database'

interface Props {
  organizationId: string
  /** 宛先 default: プリセットする場合 */
  presetChannelKind?: 'direct' | 'project'
  presetChannelUserId?: string | null
  presetChannelProjectId?: string | null
  presetDriverLabel?: string | null
  presetProjectLabel?: string | null
  onClose: () => void
  onSent?: (messageId: string) => void
}

interface DriverRow {
  user_id: string
  full_name: string | null
  email: string | null
}

export function MobilityInstructionDialog({
  organizationId,
  presetChannelKind,
  presetChannelUserId = null,
  presetChannelProjectId = null,
  presetDriverLabel = null,
  presetProjectLabel = null,
  onClose,
  onSent,
}: Props) {
  const { vehicles, activeAssignments } = useMobilityStore()
  const { sendInstruction } = useMobilityMessagesStore()

  const [channelKind, setChannelKind] = useState<'direct' | 'project'>(
    presetChannelKind ?? 'direct',
  )
  const [driverId, setDriverId] = useState<string | null>(presetChannelUserId)
  const [projectId, setProjectId] = useState<string | null>(presetChannelProjectId)
  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [pointId, setPointId] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [drivers, setDrivers] = useState<DriverRow[]>([])
  const [projects, setProjects] = useState<MobilityProject[]>([])
  const [projectPoints, setProjectPoints] = useState<MobilityProjectPoint[]>([])

  // ドライバー一覧 (組織メンバー)
  useEffect(() => {
    void (async () => {
      try {
        const { data } = (await supabase.rpc(
          'list_org_members' as never,
          { p_org_id: organizationId } as never,
        )) as { data: DriverRow[] | null }
        setDrivers(data ?? [])
      } catch {
        setDrivers([])
      }
    })()
  }, [organizationId])

  // カテゴリ (project 宛)
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await supabase
          .from('mobility_projects')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('active', true)
          .order('created_at', { ascending: false })
        setProjects((data ?? []) as MobilityProject[])
      } catch {
        setProjects([])
      }
    })()
  }, [organizationId])

  // ポイント (プロジェクトが選ばれたら or 全プロジェクト分)
  useEffect(() => {
    void (async () => {
      try {
        let query = supabase
          .from('mobility_project_points')
          .select('*')
          .eq('active', true)
          .order('display_order', { ascending: true })
        if (projectId) {
          query = query.eq('project_id', projectId)
        } else {
          // 組織内の全ポイント (プロジェクト側で RLS 効く)
          const projectIds = projects.map((p) => p.id)
          if (projectIds.length === 0) {
            setProjectPoints([])
            return
          }
          query = query.in('project_id', projectIds)
        }
        const { data, error } = await query
        if (error) {
          console.warn('[MobilityInstructionDialog] points fetch failed', error)
        }
        setProjectPoints((data ?? []) as MobilityProjectPoint[])
      } catch (err) {
        console.warn('[MobilityInstructionDialog] points fetch failed', err)
        setProjectPoints([])
      }
    })()
  }, [projectId, projects])

  // 使用中の車両を除外
  const busyVehicleIds = useMemo(
    () => new Set(Array.from(activeAssignments.keys())),
    [activeAssignments],
  )
  const availableVehicles = useMemo(
    () => vehicles.filter((v) => v.active && !busyVehicleIds.has(v.id)),
    [vehicles, busyVehicleIds],
  )

  const canSubmit =
    !busy &&
    !!pointId &&
    ((channelKind === 'direct' && !!driverId) ||
      (channelKind === 'project' && !!projectId))

  const handleSubmit = async () => {
    if (!pointId) return
    setBusy(true)
    setError(null)
    const res = await sendInstruction({
      organizationId,
      channelKind,
      channelUserId: channelKind === 'direct' ? driverId : null,
      channelProjectId: channelKind === 'project' ? projectId : null,
      vehicleId: vehicleId,
      pointId,
      body: body.trim() || null,
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onSent?.(res.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b flex items-center gap-2">
          <Send className="h-5 w-5 text-indigo-600" />
          <h3 className="text-base font-semibold flex-1">運行指示を送信</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 宛先 */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              宛先
            </label>
            {presetDriverLabel && channelKind === 'direct' ? (
              <div className="p-2 bg-slate-50 rounded border text-sm flex items-center gap-2">
                <User className="h-4 w-4 text-slate-500" />
                {presetDriverLabel}
              </div>
            ) : presetProjectLabel && channelKind === 'project' ? (
              <div className="p-2 bg-slate-50 rounded border text-sm flex items-center gap-2">
                <FolderKanban className="h-4 w-4 text-slate-500" />
                {presetProjectLabel} (現場メンバー全員)
              </div>
            ) : (
              <>
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setChannelKind('direct')}
                    className={`flex-1 py-1.5 text-xs rounded border ${
                      channelKind === 'direct'
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    <User className="h-3.5 w-3.5 inline mr-1" />
                    ドライバー個人
                  </button>
                  <button
                    type="button"
                    onClick={() => setChannelKind('project')}
                    className={`flex-1 py-1.5 text-xs rounded border ${
                      channelKind === 'project'
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    <FolderKanban className="h-3.5 w-3.5 inline mr-1" />
                    現場メンバー全員
                  </button>
                </div>
                {channelKind === 'direct' ? (
                  <select
                    value={driverId ?? ''}
                    onChange={(e) => setDriverId(e.target.value || null)}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="">-- ドライバーを選択 --</option>
                    {drivers.map((d) => (
                      <option key={d.user_id} value={d.user_id}>
                        {d.full_name || d.email || d.user_id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={projectId ?? ''}
                    onChange={(e) => setProjectId(e.target.value || null)}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="">-- 現場を選択 --</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </div>

          {/* 車両 (任意) */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              <Car className="h-3.5 w-3.5 inline mr-1" />
              車両 (任意)
            </label>
            <select
              value={vehicleId ?? ''}
              onChange={(e) => setVehicleId(e.target.value || null)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            >
              <option value="">-- 車両を指定しない (ドライバーが選ぶ) --</option>
              {availableVehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.plate_or_serial ? ` (${v.plate_or_serial})` : ''}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 mt-0.5">
              指定した場合、ドライバーが確認を押すと自動で乗車開始します
            </p>
          </div>

          {/* 行き先ポイント (必須) */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              <MapPin className="h-3.5 w-3.5 inline mr-1" />
              行き先ポイント <span className="text-red-500">*</span>
            </label>
            <select
              value={pointId ?? ''}
              onChange={(e) => setPointId(e.target.value || null)}
              className="w-full px-2 py-1.5 text-sm border rounded"
            >
              <option value="">-- 行き先を選択 --</option>
              {projectPoints.map((pt) => {
                const proj = projects.find((p) => p.id === pt.project_id)
                return (
                  <option key={pt.id} value={pt.id}>
                    {proj ? `[${proj.name}] ` : ''}
                    {pt.name}
                  </option>
                )
              })}
            </select>
          </div>

          {/* 補足メモ */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              補足メモ (任意)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="w-full px-2 py-1.5 text-sm border rounded resize-none"
              placeholder="例: 現場到着後、〇〇担当者と合流してください"
            />
          </div>

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            送信
          </button>
        </div>
      </div>
    </div>
  )
}
