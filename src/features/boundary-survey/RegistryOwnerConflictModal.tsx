// 登記 CSV 取込 時 の 地権者 名寄せ 確認 モーダル。
//
// 氏名 一致 で 住所 が 違う 候補 を 一覧 表示 し、行 ごと に
// 「既存 の どれ と 同一 か」 「新規 で 作成 する か」 を ラジオ で 選択 させる。

import { useMemo, useState } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import type {
  OwnerConflict,
  OwnerImportResolution,
} from '@/lib/registryCsvSave'

interface Props {
  conflicts: OwnerConflict[]
  onConfirm: (resolution: OwnerImportResolution) => void
  onCancel: () => void
}

export function RegistryOwnerConflictModal({
  conflicts,
  onConfirm,
  onCancel,
}: Props) {
  // 初期値: 全 conflict を 'new' に セット (安全側 = 別人 扱い、後で 統合 可能)
  const initialDecisions = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const c of conflicts) m[c.key] = 'new'
    return m
  }, [conflicts])
  const [decisions, setDecisions] =
    useState<Record<string, string>>(initialDecisions)

  const undecidedCount = conflicts.filter(
    (c) => !decisions[c.key],
  ).length

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-800">
              地権者の名寄せ確認 ({conflicts.length} 件)
            </div>
            <div className="mt-0.5 text-[11px] text-slate-600">
              氏名が同じで住所が異なる地権者が既存に存在します。
              住所変更 / 改姓等で同一人物なら既存を選択、別人なら「新規作成」を選択してください。
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 hover:bg-white/40"
            title="キャンセル (所有者データは保存されません)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-100 text-slate-600">
              <tr>
                <th className="border-b px-3 py-2 text-left w-40">CSV 氏名</th>
                <th className="border-b px-3 py-2 text-left">CSV 住所</th>
                <th className="border-b px-3 py-2 text-left w-[45%]">既存候補 / 新規作成</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => {
                const cur = decisions[c.key]
                return (
                  <tr key={c.key} className="border-b align-top">
                    <td className="px-3 py-2 font-semibold text-slate-800">
                      {c.csvName}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {c.csvAddress || '(住所なし)'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        {c.candidates.map((cand) => (
                          <label
                            key={cand.id}
                            className="flex items-start gap-2 cursor-pointer hover:bg-blue-50 rounded px-1 py-0.5"
                          >
                            <input
                              type="radio"
                              name={`conflict-${c.key}`}
                              value={cand.id}
                              checked={cur === cand.id}
                              onChange={() =>
                                setDecisions((d) => ({
                                  ...d,
                                  [c.key]: cand.id,
                                }))
                              }
                              className="mt-0.5"
                            />
                            <span className="text-slate-700">
                              <span className="font-medium">{cand.name}</span>
                              <span className="ml-2 text-slate-500">
                                {cand.address || '(住所なし)'}
                              </span>
                            </span>
                          </label>
                        ))}
                        <label className="flex items-start gap-2 cursor-pointer hover:bg-emerald-50 rounded px-1 py-0.5">
                          <input
                            type="radio"
                            name={`conflict-${c.key}`}
                            value="new"
                            checked={cur === 'new'}
                            onChange={() =>
                              setDecisions((d) => ({ ...d, [c.key]: 'new' }))
                            }
                            className="mt-0.5"
                          />
                          <span className="text-emerald-700 font-medium">
                            別人として新規作成
                          </span>
                        </label>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-500">
            {undecidedCount > 0
              ? `未選択: ${undecidedCount} 件`
              : `${conflicts.length} 件すべて選択済`}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center gap-1 rounded border px-3 py-1.5 text-xs hover:bg-slate-100"
            >
              <X className="h-3.5 w-3.5" />
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => onConfirm({ decisions })}
              disabled={undecidedCount > 0}
              className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check className="h-3.5 w-3.5" />
              確定 ({conflicts.length}件)
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
