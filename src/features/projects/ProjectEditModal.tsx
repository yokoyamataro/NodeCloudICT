// 現場 (project) の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。
//   フィールド:
//     基本    : 工事名 / 説明 / 種別 / 座標系
//     関係者  : 発注者 / 受託者
//     工期    : 工期開始日 / 工期終了日 (予定)
//     進捗    : 着手日 / 完成日 (実際の作業実績) + 完了チェック
//     アクション: 現場を削除する (ゴミ箱へ)

import { useEffect, useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import type { Project, ProjectCategory } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { isoToDateInput, dateInputToIso } from '@/features/farms/FarmEditModal'

// YYYY-MM-DD 形式の日付 (DATE 型: start_date / end_date) → date input value
function dateStringToInput(s: string | null): string {
  if (!s) return ''
  // 'YYYY-MM-DD' がそのまま入る想定。念のためスライスして 10 文字取る
  return s.slice(0, 10)
}

export function ProjectEditModal({
  project,
  onUpdateProject,
  onClose,
  onDelete,
}: {
  project: Project
  onUpdateProject: (
    patch: Partial<
      Pick<
        Project,
        | 'name'
        | 'description'
        | 'start_date'
        | 'end_date'
        | 'client'
        | 'contractor'
        | 'coordinate_zone'
        | 'category'
        | 'started_at'
        | 'completed_at'
      >
    >,
  ) => void
  onClose: () => void
  /** 渡された場合のみ「現場を削除する」ボタンを表示 */
  onDelete?: () => void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [startDate, setStartDate] = useState(dateStringToInput(project.start_date))
  const [endDate, setEndDate] = useState(dateStringToInput(project.end_date))
  const [zone, setZone] = useState<number>(project.coordinate_zone ?? 13)
  const [category, setCategory] = useState<ProjectCategory | null>(project.category)
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(project.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(project.completed_at))

  useEffect(() => {
    setName(project.name)
    setDescription(project.description ?? '')
    setClient(project.client ?? '')
    setContractor(project.contractor ?? '')
    setStartDate(dateStringToInput(project.start_date))
    setEndDate(dateStringToInput(project.end_date))
    setZone(project.coordinate_zone ?? 13)
    setCategory(project.category)
    setStartedAt(isoToDateInput(project.started_at))
    setCompletedAt(isoToDateInput(project.completed_at))
  }, [
    project.id,
    project.name,
    project.description,
    project.client,
    project.contractor,
    project.start_date,
    project.end_date,
    project.coordinate_zone,
    project.category,
    project.started_at,
    project.completed_at,
  ])

  const commitName = () => {
    const v = name.trim()
    if (v && v !== project.name) onUpdateProject({ name: v })
    else if (!v) setName(project.name)
  }
  const commitDescription = () => {
    const v = description.trim()
    const prev = project.description ?? ''
    if (v !== prev) onUpdateProject({ description: v || null })
  }
  const commitClient = () => {
    const v = client.trim()
    const prev = project.client ?? ''
    if (v !== prev) onUpdateProject({ client: v || null })
  }
  const commitContractor = () => {
    const v = contractor.trim()
    const prev = project.contractor ?? ''
    if (v !== prev) onUpdateProject({ contractor: v || null })
  }
  const commitStartDate = () => {
    const v = startDate || null
    if (v !== (project.start_date ?? null)) onUpdateProject({ start_date: v })
  }
  const commitEndDate = () => {
    const v = endDate || null
    if (v !== (project.end_date ?? null)) onUpdateProject({ end_date: v })
  }
  const commitStartedAt = () => {
    const iso = dateInputToIso(startedAt)
    if (iso !== project.started_at) onUpdateProject({ started_at: iso })
  }
  const commitCompletedAt = () => {
    const iso = dateInputToIso(completedAt)
    if (iso !== project.completed_at) onUpdateProject({ completed_at: iso })
  }

  const isCompleted = project.completed_at != null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">現場の編集</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-3 overflow-y-auto flex-1 space-y-3">
          {/* 工事名 */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">工事名</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>

          {/* 種別 */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">種別</label>
            <div className="flex gap-1">
              {(['cadastral', 'civil'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    if (category !== c) {
                      setCategory(c)
                      onUpdateProject({ category: c })
                    }
                  }}
                  className={`flex-1 px-2 py-1.5 text-xs rounded border ${
                    category === c
                      ? c === 'cadastral'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {PROJECT_CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          {/* 説明 */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              placeholder="任意"
              className="w-full px-2 py-2 border rounded text-sm h-16"
            />
          </div>

          {/* 発注者 / 受託者 */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">発注者</label>
              <input
                type="text"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                onBlur={commitClient}
                placeholder="任意"
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">受託者</label>
              <input
                type="text"
                value={contractor}
                onChange={(e) => setContractor(e.target.value)}
                onBlur={commitContractor}
                placeholder="任意"
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
          </div>

          {/* 座標系 */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">座標系</label>
            <select
              value={zone}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                setZone(n)
                if (n !== project.coordinate_zone) onUpdateProject({ coordinate_zone: n })
              }}
              className="w-full px-2 py-2 text-sm border rounded"
            >
              {Object.entries(JGD2011_ZONES).map(([z, info]) => (
                <option key={z} value={z}>
                  {info.name}
                </option>
              ))}
            </select>
          </div>

          {/* 工期 (予定) */}
          <div>
            <div className="text-[11px] text-slate-500 mb-1">工期 (予定)</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                onBlur={commitStartDate}
                className="w-full px-2 py-2 border rounded text-sm"
                title="工期開始日"
              />
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                onBlur={commitEndDate}
                className="w-full px-2 py-2 border rounded text-sm"
                title="工期終了日"
              />
            </div>
          </div>

          {/* 着手日 (実績) */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">着手日 (実績)</label>
            <input
              type="date"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              onBlur={commitStartedAt}
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>

          {/* 進捗 / 完成日 (実績) */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">進捗 / 完成日 (実績)</label>
            <label className="flex items-center gap-2 px-2 py-2 border rounded cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={isCompleted}
                onChange={(e) => {
                  if (e.target.checked) {
                    const iso = project.completed_at ?? new Date().toISOString()
                    onUpdateProject({ completed_at: iso })
                    setCompletedAt(isoToDateInput(iso))
                  } else {
                    onUpdateProject({ completed_at: null })
                    setCompletedAt('')
                  }
                }}
                className="h-4 w-4"
              />
              <span className="text-sm">完了</span>
            </label>
            <input
              type="date"
              value={completedAt}
              onChange={(e) => setCompletedAt(e.target.value)}
              onBlur={commitCompletedAt}
              disabled={!isCompleted}
              className="w-full px-2 py-2 border rounded text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>

          {/* 削除 */}
          {onDelete && (
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `現場「${project.name}」をゴミ箱へ移動しますか？\n\n7 日以内なら「ゴミ箱」から復元できます。\n7 日を超えると配下の工区・関連データすべてが自動で完全削除されます。`,
                    )
                  ) {
                    onDelete()
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                現場を削除する
              </button>
            </div>
          )}
        </div>
        <div className="px-3 py-2 border-t shrink-0">
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 text-sm border rounded-lg hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
