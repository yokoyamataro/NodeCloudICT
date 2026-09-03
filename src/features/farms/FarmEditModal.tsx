// 工区の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。名前 / 説明 / 着手日 / 完成日 (= 完了) を編集する。
//   モバイルとPCの両方で利用する。
//   工区オーナー本人 (currentUserId === farm.user_id) には、別現場への移動 UI も出す。

import { useEffect, useState } from 'react'
import { X, Trash2, ArrowRightLeft } from 'lucide-react'
import type { Farm } from '@/stores/farmStore'

/** 移動候補 の 現場 (呼出側 で 抽出 済み)。同一 オーナー + 座標系一致 の 判定 は 呼出側 で 行う */
export interface FarmMoveTarget {
  id: string
  name: string
  coordinate_zone: number
  isSameOwner: boolean
}

export function isoToDateInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function dateInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function FarmEditModal({
  farm,
  onUpdateFarm,
  onClose,
  onDelete,
  currentUserId,
  sourceProjectZone,
  moveTargets,
  onMove,
}: {
  farm: Farm
  onUpdateFarm: (patch: Partial<Pick<Farm, 'name' | 'description' | 'started_at' | 'completed_at'>>) => void
  onClose: () => void
  /** 指定時のみ「工区を削除する」ボタンを完成日の下に表示。押下 → 確認 → 呼び出し */
  onDelete?: () => void
  /** 現在のログイン ユーザー ID。 farm.user_id と一致 する 場合 に 移動 UI を 出す */
  currentUserId?: string | null
  /** 移動元 (現在の 現場) の 座標系。 移動先 と 一致 する 場合 の みず 実行 可 */
  sourceProjectZone?: number
  /** 同一オーナー の 現場 一覧 (現在の 現場 を 除く)。 未指定 or 空 なら 移動 UI 非表示 */
  moveTargets?: FarmMoveTarget[]
  /** 移動 実行 コールバック。 呼出側 で ストア 更新 + fetch を 実施 */
  onMove?: (targetProjectId: string) => Promise<void>
}) {
  const [name, setName] = useState(farm.name)
  const [description, setDescription] = useState(farm.description ?? '')
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(farm.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(farm.completed_at))
  const [moveTargetId, setMoveTargetId] = useState<string>('')
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    setName(farm.name)
    setDescription(farm.description ?? '')
    setStartedAt(isoToDateInput(farm.started_at))
    setCompletedAt(isoToDateInput(farm.completed_at))
    setMoveTargetId('')
  }, [farm.id, farm.name, farm.description, farm.started_at, farm.completed_at])

  const commitName = () => {
    const v = name.trim()
    if (v && v !== farm.name) onUpdateFarm({ name: v })
    else if (!v) setName(farm.name)
  }
  const commitDescription = () => {
    const v = description.trim()
    const prev = farm.description ?? ''
    if (v !== prev) onUpdateFarm({ description: v || null })
  }
  const commitStartedAt = () => {
    const iso = dateInputToIso(startedAt)
    if (iso !== farm.started_at) onUpdateFarm({ started_at: iso })
  }
  const commitCompletedAt = () => {
    const iso = dateInputToIso(completedAt)
    if (iso !== farm.completed_at) onUpdateFarm({ completed_at: iso })
  }

  const isCompleted = farm.completed_at != null

  // 移動 UI の 出現 条件: (1) ログイン中 (2) 自分 が 工区 オーナー (3) 候補 あり
  const canMove =
    currentUserId != null &&
    farm.user_id === currentUserId &&
    (moveTargets?.length ?? 0) > 0 &&
    onMove != null
  const selectedTarget = moveTargets?.find((t) => t.id === moveTargetId) ?? null
  const zoneMismatch =
    selectedTarget != null &&
    sourceProjectZone != null &&
    selectedTarget.coordinate_zone !== sourceProjectZone

  const handleMove = async () => {
    if (!onMove || !selectedTarget) return
    if (!selectedTarget.isSameOwner) {
      alert('移動先 の 現場 は 同一 オーナー で ある 必要 が あります。')
      return
    }
    if (zoneMismatch) {
      alert(
        `座標系 が 異なる ため 移動 できません。\n\n` +
          `移動元: ${sourceProjectZone} 系\n` +
          `移動先: ${selectedTarget.coordinate_zone} 系\n\n` +
          `同じ 座標系 の 現場 を 選択 して ください。`,
      )
      return
    }
    if (
      !confirm(
        `工区「${farm.name}」を 現場「${selectedTarget.name}」に 移動 します。\n\n` +
          `関連する 座標 / 地番 / 記録 等 は 工区 と 一緒 に 移動 します。\n実行 しますか？`,
      )
    ) {
      return
    }
    try {
      setMoving(true)
      await onMove(selectedTarget.id)
      onClose()
    } catch (err) {
      alert(err instanceof Error ? err.message : '工区の移動に失敗しました')
    } finally {
      setMoving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">工区の編集</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-3 overflow-y-auto flex-1 space-y-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">工区名</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              className="w-full px-2 py-2 border rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={commitDescription}
              placeholder="任意"
              className="w-full px-2 py-2 border rounded text-sm h-20"
            />
          </div>
          {/* 着手日 + 完了チェック + 完成日 を 1 行に */}
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">着手日 / 完成日</label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
                onBlur={commitStartedAt}
                className="flex-1 px-2 py-2 border rounded text-sm"
                title="着手日"
              />
              <label className="flex items-center gap-1.5 px-2 py-2 border rounded cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={isCompleted}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const iso = farm.completed_at ?? new Date().toISOString()
                      onUpdateFarm({ completed_at: iso })
                      setCompletedAt(isoToDateInput(iso))
                    } else {
                      onUpdateFarm({ completed_at: null })
                      setCompletedAt('')
                    }
                  }}
                  className="h-4 w-4"
                />
                <span className="text-xs">完了</span>
              </label>
              <input
                type="date"
                value={completedAt}
                onChange={(e) => setCompletedAt(e.target.value)}
                onBlur={commitCompletedAt}
                disabled={!isCompleted}
                className="flex-1 px-2 py-2 border rounded text-sm disabled:bg-slate-50 disabled:text-slate-400"
                title="完成日"
              />
            </div>
          </div>

          {/* 移動: 同一 オーナー の 別 現場 に この 工区 を 移す。
              関連する 座標 / 地番 / 記録 等 は farm_id 参照 の まま 保たれる。
              座標系 が 異なる 場合 は 実行 不可 (呼出側 で 抽出 済み だが 二重チェック)。 */}
          {canMove && (
            <div className="pt-2 border-t space-y-2">
              <label className="block text-[11px] text-slate-500">
                別 現場 に 移動 (同一 オーナー)
              </label>
              <select
                value={moveTargetId}
                onChange={(e) => setMoveTargetId(e.target.value)}
                className="w-full px-2 py-2 border rounded text-sm bg-white"
                disabled={moving}
              >
                <option value="">移動先 の 現場 を 選択…</option>
                {moveTargets!.map((t) => (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={
                      !t.isSameOwner ||
                      (sourceProjectZone != null && t.coordinate_zone !== sourceProjectZone)
                    }
                  >
                    {t.name} ({t.coordinate_zone} 系)
                    {sourceProjectZone != null && t.coordinate_zone !== sourceProjectZone
                      ? ' — 座標系 が 異なる ため 不可'
                      : !t.isSameOwner
                        ? ' — 別オーナー'
                        : ''}
                  </option>
                ))}
              </select>
              {zoneMismatch && (
                <div className="text-[11px] text-red-600">
                  座標系 が 異なる ため 移動 できません。
                </div>
              )}
              <button
                type="button"
                onClick={() => void handleMove()}
                disabled={
                  !selectedTarget ||
                  moving ||
                  !selectedTarget.isSameOwner ||
                  zoneMismatch
                }
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowRightLeft className="h-4 w-4" />
                {moving ? '移動中…' : 'この 現場 に 移動 する'}
              </button>
            </div>
          )}

          {/* 完了日の下: 工区を削除するボタン (onDelete が渡されたときのみ表示) */}
          {onDelete && (
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `工区「${farm.name}」をゴミ箱へ移動しますか？\n\n7 日以内なら「ゴミ箱」から復元できます。\n7 日を超えると座標・地番ポリゴン・地番属性・写真・LandXML・オルソタイル等の関連データも自動で完全削除されます。`,
                    )
                  ) {
                    onDelete()
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                工区を削除する
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
