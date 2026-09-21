// 実測 の 記録セット の 管理。
//
// 実測 は 日 や 担当者 が 変われば 使う 基準局 も 設定 も 変わる ので、
// スライド量 は セット ごと に 持つ。 同じ 日 / 同じ 人 でも 分けられる。
//
// 「既定」 の セット が 新しい 記録 の 入り先 に なる。

import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Star, Trash2 } from 'lucide-react'
import {
  setLabel,
  useSurveySetStore,
  type SurveyRecordSet,
} from '@/stores/surveySetStore'

const inputCls = 'w-full px-1.5 py-1 text-xs border rounded'

function NumCell({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      type="text"
      inputMode="decimal"
      className="w-20 px-1.5 py-1 text-xs border rounded text-right font-mono"
      value={text ?? String(value)}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        const n = Number(t)
        if (t.trim() === '') onChange(0)
        else if (Number.isFinite(n)) onChange(n)
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setText(null)}
    />
  )
}

/** 開始 / 終了日時。 未記録 は — */
function fmtStamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ja-JP', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SurveyRecordSetsPanel({
  farmId,
  countBySet,
}: {
  farmId: string | null
  /** セット id → 記録 の 数。 null の 鍵 は 未振り分け */
  countBySet: Map<string | null, number>
}) {
  const { sets, loading, error, updateSet, setDefault, deleteSet } = useSurveySetStore()
  const [openId, setOpenId] = useState<string | null>(null)

  const handleDelete = async (s: SurveyRecordSet) => {
    const n = countBySet.get(s.id) ?? 0
    const msg =
      n > 0
        ? `「${setLabel(s)}」を 消します。 この セッション の 記録 ${n} 点 は 未振り分け に なります (記録 自体 は 残ります)。 よろしいですか？`
        : `「${setLabel(s)}」を 消します。 よろしいですか？`
    if (!window.confirm(msg)) return
    await deleteSet(s.id)
  }

  const unassigned = countBySet.get(null) ?? 0

  return (
    <div className="space-y-2 text-xs">
      <div className="text-slate-500">
        セッション (実測記録の 束)。 スライド量 は セッション ごと に 持ちます。
        別 の 日 / 別 の 担当者 / 基準局 や 設定 を 変えた ときは 新しい セッション に します。
      </div>

      {unassigned > 0 && (
        <div className="text-amber-700">未振り分け {unassigned} 点</div>
      )}

      {error && <div className="text-[11px] text-red-600 whitespace-pre-line">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-1 text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          読み込み中…
        </div>
      ) : sets.length === 0 ? (
        <div className="text-slate-400">
          セッションがありません。 タブ の 右端 の 「+ セッション」 から 作ります。
        </div>
      ) : (
        <ul className="border rounded divide-y">
          {sets.map((s) => {
            const open = openId === s.id
            const n = countBySet.get(s.id) ?? 0
            return (
              <li key={s.id}>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : s.id)}
                    className="p-0.5 text-slate-400 hover:text-slate-700"
                  >
                    {open ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <span className="flex-1 min-w-0 truncate">{setLabel(s)}</span>
                  <span className="text-[11px] text-slate-400 font-mono">{n} 点</span>
                  <span
                    className="text-[10px] text-slate-500 font-mono"
                    title="スライド量 (dx / dy / dz)"
                  >
                    {s.slide.dx.toFixed(3)} / {s.slide.dy.toFixed(3)} / {s.slide.dz.toFixed(3)}
                  </span>
                  <button
                    type="button"
                    onClick={() => farmId && void setDefault(farmId, s.id)}
                    className={`p-0.5 rounded ${
                      s.isDefault ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'
                    }`}
                    title={s.isDefault ? '新しい記録の入り先' : 'これを新しい記録の入り先にする'}
                  >
                    <Star className="h-3.5 w-3.5" fill={s.isDefault ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(s)}
                    className="p-0.5 text-slate-400 hover:text-red-600"
                    title="このセッションを削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {open && (
                  <div className="px-3 pb-2 space-y-1 bg-slate-50">
                    <div className="grid grid-cols-2 gap-1">
                      <label className="block">
                        <span className="text-[11px] text-slate-500">名前</span>
                        <input
                          className={inputCls}
                          value={s.name ?? ''}
                          onChange={(e) => void updateSet(s.id, { name: e.target.value || null })}
                          placeholder="空なら 日付 + 担当者"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">測量日</span>
                        <input
                          type="date"
                          className={inputCls}
                          value={s.measuredOn ?? ''}
                          onChange={(e) =>
                            void updateSet(s.id, { measuredOn: e.target.value || null })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">担当者</span>
                        <input
                          className={inputCls}
                          value={s.operator ?? ''}
                          onChange={(e) =>
                            void updateSet(s.id, { operator: e.target.value || null })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">基準局</span>
                        <input
                          className={inputCls}
                          value={s.baseStation ?? ''}
                          onChange={(e) =>
                            void updateSet(s.id, { baseStation: e.target.value || null })
                          }
                          placeholder="例: ネットワーク型RTK / 自営局 R7T1"
                        />
                      </label>
                    </div>
                    <label className="block">
                      <span className="text-[11px] text-slate-500">設定のメモ</span>
                      <input
                        className={inputCls}
                        value={s.settingsNote ?? ''}
                        onChange={(e) =>
                          void updateSet(s.id, { settingsNote: e.target.value || null })
                        }
                        placeholder="例: アンテナ高 1.800 / FIX のみ採用"
                      />
                    </label>
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-[11px] text-slate-500">スライド量</span>
                      <span className="text-[11px] text-slate-400">dX</span>
                      <NumCell
                        value={s.slide.dx}
                        onChange={(v) => void updateSet(s.id, { slide: { ...s.slide, dx: v } })}
                      />
                      <span className="text-[11px] text-slate-400">dY</span>
                      <NumCell
                        value={s.slide.dy}
                        onChange={(v) => void updateSet(s.id, { slide: { ...s.slide, dy: v } })}
                      />
                      <span className="text-[11px] text-slate-400">dZ</span>
                      <NumCell
                        value={s.slide.dz}
                        onChange={(v) => void updateSet(s.id, { slide: { ...s.slide, dz: v } })}
                      />
                    </div>
                    <div className="text-[11px] text-slate-400">
                      実測 から この 量 を 引いた もの が 当初 の 土俵 に 乗る 値 です
                      (補正実測値 = 実測 − スライド量)。
                    </div>
                    {/* 作業 の 幅。 スマホ で セット を 選んだ 時刻 と、最後 に
                        記録 が 入った 時刻 が 自動 で 入る (手入力 は しない) */}
                    <div className="text-[11px] text-slate-500 font-mono">
                      作業 {fmtStamp(s.startedAt)} 〜 {fmtStamp(s.endedAt)}
                    </div>
                    {s.isDefault && (
                      <div className="flex items-center gap-1 text-[11px] text-amber-700">
                        <Check className="h-3 w-3" />
                        新しい記録はこのセッションに入ります
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
