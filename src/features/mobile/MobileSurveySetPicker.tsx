// 作業 を 始める とき に セッション を 決める。
//
// 起動後 に 最初 の 「測定」 を 押した ところ で 1 回 だけ 出す。
// 「直前 の セッション に 追加」 は 当日 (JST 基準) の セッション だけ 選べる。
// 翌日 は 必然 的 に 「新規セッション」 に なる (仕様)。
//
// 名前 は デフォルト で 「NNN{A,B,C}」 (JST 年通算日 + 同日内 連番) を 提案し、
// 必要 なら 差し替え可 (リネーム は 後 からで も 可)。

import { useMemo, useState } from 'react'
import { Loader2, Plus, X, ArrowRight } from 'lucide-react'
import {
  setLabel,
  useSurveySetStore,
  generateDefaultSessionName,
  jstTodayIso,
  type SurveyRecordSet,
} from '@/stores/surveySetStore'

/** 最後 に 触った 時刻。 新しい 順 に 並べる ため の 鍵 */
function lastTouch(s: SurveyRecordSet): string {
  return s.endedAt ?? s.startedAt ?? s.createdAt ?? ''
}

const hhmm = (iso: string | null): string =>
  iso ? iso.slice(5, 16).replace('T', ' ') : '—'

export function MobileSurveySetPicker({
  farmId,
  onDecided,
  onCancel,
}: {
  farmId: string
  /** 選んだ / 作った セッション。 これ 以降 の 実測 は この セッション に 入る */
  onDecided: (setId: string) => void
  onCancel: () => void
}) {
  const sets = useSurveySetStore((s) => s.sets)
  const createSet = useSurveySetStore((s) => s.createSet)
  const [busy, setBusy] = useState(false)

  // 「直前」 に 追加 できる のは JST の 今日 に 属する セッション のみ。
  // 翌日 に なった ら 選択肢 から 消えて、必然 的 に 新規 作成 に なる。
  const today = jstTodayIso()
  const todaySets = useMemo(
    () =>
      sets
        .filter((s) => s.measuredOn === today)
        .sort((a, b) => lastTouch(b).localeCompare(lastTouch(a))),
    [sets, today],
  )

  const suggestedName = useMemo(() => generateDefaultSessionName(sets), [sets])
  const [name, setName] = useState(suggestedName)
  const [operator, setOperator] = useState('')

  const handleUseExisting = (id: string) => {
    onDecided(id)
  }
  const handleCreateNew = async () => {
    setBusy(true)
    try {
      const row = await createSet(farmId, {
        measuredOn: today,
        name: name.trim() || suggestedName,
        operator: operator.trim() || null,
      })
      if (row) onDecided(row.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[4000] bg-black/50 flex items-end">
      <div className="bg-white w-full rounded-t-xl shadow-xl max-h-[85vh] flex flex-col">
        <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold">セッション を 選ぶ</div>
            <div className="text-[11px] text-slate-500">
              「直前 に 追加」は 今日 (JST) の セッション のみ。 翌日 は 新規 に なります。
            </div>
          </div>
          <button
            onClick={onCancel}
            className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-2 space-y-3">
          {/* 直前 の セッション に 追加 (今日 の 分 だけ) */}
          <section className="border rounded">
            <div className="px-2 py-1.5 border-b bg-slate-50 text-xs font-semibold text-slate-700">
              直前 の セッション に 追加
            </div>
            {todaySets.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-slate-500">
                今日 の セッション が まだ ありません。 「新規 セッション を 作成」 で 始めて ください。
              </div>
            ) : (
              <ul className="divide-y">
                {todaySets.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => handleUseExisting(s.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium truncate">{setLabel(s)}</span>
                        {i === 0 && (
                          <span className="ml-1 text-[10px] px-1 rounded bg-blue-100 text-blue-700">
                            直近
                          </span>
                        )}
                        <span className="block text-[11px] text-slate-500 font-mono">
                          {hhmm(s.startedAt)} 〜 {hhmm(s.endedAt)}
                        </span>
                        <span className="block text-[11px] text-slate-500 font-mono">
                          スライド dX {s.slide.dx.toFixed(3)} / dY {s.slide.dy.toFixed(3)} / dZ{' '}
                          {s.slide.dz.toFixed(3)}
                        </span>
                      </span>
                      <ArrowRight className="h-4 w-4 text-slate-400 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 新規 セッション の 作成 */}
          <section className="border rounded p-2 space-y-2">
            <div className="text-xs font-semibold text-slate-700">新規 セッション を 作成</div>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 w-12 shrink-0">名前</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={suggestedName}
                className="flex-1 px-2 py-1.5 border rounded text-sm font-mono"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 w-12 shrink-0">担当者</span>
              <input
                type="text"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                placeholder="(任意)"
                className="flex-1 px-2 py-1.5 border rounded text-sm"
              />
            </label>
            <button
              onClick={() => void handleCreateNew()}
              disabled={busy}
              className="w-full flex items-center justify-center gap-1 px-3 py-2 rounded bg-blue-600 text-white font-medium disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              新規 セッション で 開始
            </button>
            <div className="text-[11px] text-slate-400">
              測量日 は 今日 (JST)。 基準局 や スライド量 は 後 から 直せます。
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
