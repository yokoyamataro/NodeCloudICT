// 作業 を 始める とき に 実測記録セット を 決める。
//
// 起動後 に 最初 の 「測定」 を 押した ところ で 1 回 だけ 出す。 別 の 日 /
// 別 の 担当者 / 基準局 を 変えた ら 新しい セット に する 運用 な ので、
// 「続き から」 か 「新しく 作る」 か を ここ で 選ぶ。
//
// 既定 は 直近 の セット (最後 に 記録 が 入った もの)。 そのまま 「開始」 を
// 押せば 続き に なる。

import { useMemo, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { setLabel, useSurveySetStore, type SurveyRecordSet } from '@/stores/surveySetStore'

/** 最後 に 触った 時刻。 新しい 順 に 並べる ため の 鍵 */
function lastTouch(s: SurveyRecordSet): string {
  return s.endedAt ?? s.startedAt ?? s.createdAt ?? ''
}

/** 直近 の セット (最後 に 記録 が 入った もの)。 無ければ null */
function latestSet(sets: SurveyRecordSet[]): SurveyRecordSet | null {
  if (sets.length === 0) return null
  return [...sets].sort((a, b) => lastTouch(b).localeCompare(lastTouch(a)))[0]
}

const hhmm = (iso: string | null): string =>
  iso ? iso.slice(5, 16).replace('T', ' ') : '—'

export function MobileSurveySetPicker({
  farmId,
  onDecided,
  onCancel,
}: {
  farmId: string
  /** 選んだ / 作った セット。 これ 以降 の 実測 は この セット に 入る */
  onDecided: (setId: string) => void
  onCancel: () => void
}) {
  const sets = useSurveySetStore((s) => s.sets)
  const createSet = useSurveySetStore((s) => s.createSet)
  const [busy, setBusy] = useState(false)
  const ordered = useMemo(
    () => [...sets].sort((a, b) => lastTouch(b).localeCompare(lastTouch(a))),
    [sets],
  )
  const [picked, setPicked] = useState<string | null>(() => latestSet(sets)?.id ?? null)
  const [operator, setOperator] = useState('')
  const [name, setName] = useState('')

  const handleStart = () => {
    if (!picked) return
    onDecided(picked)
  }
  const handleCreate = async () => {
    setBusy(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const row = await createSet(farmId, {
        measuredOn: today,
        name: name.trim() || null,
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
              スライド量 は セッション ごと。 日 や 担当者、基準局 が 変わった ら 新しく。
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

        <div className="flex-1 min-h-0 overflow-auto p-2 space-y-2">
          {ordered.length > 0 && (
            <ul className="border rounded divide-y">
              {ordered.map((s, i) => (
                <li key={s.id}>
                  <label className="flex items-center gap-2 px-2 py-2 text-sm">
                    <input
                      type="radio"
                      name="survey-set"
                      checked={picked === s.id}
                      onChange={() => setPicked(s.id)}
                    />
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
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="border rounded p-2 space-y-2">
            <div className="text-xs font-semibold text-slate-700">新しい セッション で 始める</div>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-slate-500 w-12 shrink-0">名前</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="(空 なら 測量日 と 担当者)"
                className="flex-1 px-2 py-1.5 border rounded text-sm"
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
              onClick={() => void handleCreate()}
              disabled={busy}
              className="w-full flex items-center justify-center gap-1 px-3 py-2 border rounded bg-white text-slate-700 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              新しい セッション を 作って 開始
            </button>
            <div className="text-[11px] text-slate-400">
              測量日 は 今日。 基準局 や スライド量 は 後 から 直せます。
            </div>
          </div>
        </div>

        <div className="px-3 py-2 border-t bg-slate-50 shrink-0">
          <button
            onClick={handleStart}
            disabled={!picked || busy}
            className="w-full px-3 py-2.5 rounded bg-blue-600 text-white font-medium disabled:opacity-40"
          >
            この セッション で 開始
          </button>
        </div>
      </div>
    </div>
  )
}
