// スマホ の 実測一覧。
//
// 行 の 束ね方 (実測1 / 実測2) と 計算 は PC の 実測記録 と 同じ (lib/stakingGroups)。
// 違う のは 幅 の 使い方 だけ:
//   ・出す 列 の かたまり を 選べる (既定 は 全部)
//   ・1 行 は 折り返さ ず、はみ出す 分 は 横 スクロール
//   ・記録セット を タブ で 切替、その セット の スライド量 を その場 で 直せる
//
// 記録 の 付け替え や 削除、セット の 追加 は PC に 任せる。

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { useStakingStore, type StakingRecord } from '@/stores/stakingStore'
import { deriveRow, groupStakingRecords, type StakingGroup } from '@/lib/stakingGroups'
import { setLabel, useSurveySetStore, generateDefaultSessionName, jstTodayIso } from '@/stores/surveySetStore'
import {
  fetchSurveySlide,
  saveSurveySlide,
  NO_SLIDE,
  type SurveySlide,
} from '@/lib/surveyCalibration'

const f3 = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(3))

/**
 * スライド量 の 1 軸 ぶん の 入力。 触って いない 間 は mm 単位 (小数 3 桁)、
 * フォーカス 中 だけ 生 の 文字列 を 持つ (末尾 の 0 が 邪魔 で 打てない の を 避ける)。
 */
function SlideField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string
  value: number
  onCommit: (v: number) => void
  disabled?: boolean
}) {
  const [buf, setBuf] = useState<string | null>(null)
  return (
    <label className="flex items-center gap-1">
      <span className="text-slate-500">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={buf ?? value.toFixed(3)}
        onFocus={() => setBuf(String(value))}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => {
          const raw = buf
          setBuf(null)
          if (raw == null) return
          const n = parseFloat(raw.trim())
          if (!Number.isFinite(n)) return
          const rounded = Math.round(n * 1000) / 1000
          if (rounded !== value) onCommit(rounded)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        className="w-16 px-1 py-0.5 border rounded text-right tabular-nums bg-white disabled:bg-slate-100"
      />
    </label>
  )
}

/**
 * 出せる 列 の かたまり。 PC の 実測記録 と 同じ 並び / 同じ 呼び方 に 揃える。
 * 既定 は 全部 出す (横 に スクロール すれば 読める)。 選択 は 端末 に 憶える。
 */
const GROUPS = [
  { key: 'design', label: '当初' },
  { key: 'm1', label: '実測1' },
  { key: 'm2', label: '実測2' },
  { key: 'diff', label: '実測差' },
  { key: 'avg', label: '実測平均' },
  { key: 'dvs', label: '実測平均-当初' },
  { key: 'slided', label: 'スライド値' },
  { key: 'rev', label: '補正実測値' },
] as const
type GroupKey = (typeof GROUPS)[number]['key']
const DEFAULT_GROUPS: GroupKey[] = GROUPS.map((g) => g.key)
const GROUP_LS_KEY = 'mobile:stakingRecordGroups'

export function MobileStakingRecordsSheet({
  farmId,
  onClose,
}: {
  farmId: string
  onClose: () => void
}) {
  const records = useStakingStore((s) => s.records)
  const updateSet = useSurveySetStore((s) => s.updateSet)
  const loading = useStakingStore((s) => s.loading)
  const fetchRecords = useStakingStore((s) => s.fetchRecords)
  const sets = useSurveySetStore((s) => s.sets)
  const activeSetId = useSurveySetStore((s) => s.activeSetId)
  const fetchSets = useSurveySetStore((s) => s.fetchByFarm)
  /** 工区 単位 の スライド量。 セット に 属さない 記録 は これ で 見る */
  const [farmSlide, setFarmSlide] = useState<SurveySlide>(NO_SLIDE)
  // タブ は 必ず どれ か 1 つ の セット (または 未振り分け)。 混ざる と
  // どの 補正値 で 見て いる か 分から なく なる ので 「すべて」 は 出さない。
  const [tab, setTab] = useState<string>('none')

  useEffect(() => {
    void fetchRecords(farmId)
    void fetchSets(farmId)
    void fetchSurveySlide(farmId).then(setFarmSlide)
  }, [farmId, fetchRecords, fetchSets])

  const mine = useMemo(
    () => records.filter((r) => r.farmId === farmId),
    [records, farmId],
  )
  /** その 記録 の 土俵。 セット に 属さない 記録 は 工区 の 既定 */
  const slideOf = (r: StakingRecord | null): SurveySlide =>
    (r?.recordSetId ? sets.find((s) => s.id === r.recordSetId)?.slide : undefined) ?? farmSlide

  const countBySet = useMemo(() => {
    const m = new Map<string | null, number>()
    for (const r of mine) {
      const k = r.recordSetId ?? null
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [mine])

  /** 表 に 出す 行。 PC と 同じ 束ね方 (実測1 / 実測2) */
  const shown = useMemo<StakingGroup[]>(() => {
    const base =
      tab === 'none'
        ? mine.filter((r) => !r.recordSetId)
        : mine.filter((r) => r.recordSetId === tab)
    return groupStakingRecords(base)
  }, [mine, tab])

  // 作業中 の セット (無ければ 既定 / 先頭) を 初期選択 に する
  useEffect(() => {
    if (sets.length === 0) return
    setTab((prev) => {
      if (prev !== 'none' && sets.some((s) => s.id === prev)) return prev
      const pick = (activeSetId && sets.find((s) => s.id === activeSetId)) ||
        sets.find((s) => s.isDefault) ||
        sets[0]
      return pick ? pick.id : prev
    })
  }, [sets, activeSetId])

  /** 出す 列 の かたまり。 端末 に 憶えて おく */
  const [groups, setGroups] = useState<Set<GroupKey>>(() => {
    try {
      const raw = localStorage.getItem(GROUP_LS_KEY)
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        const ok = arr.filter((k): k is GroupKey => GROUPS.some((g) => g.key === k))
        if (ok.length > 0) return new Set(ok)
      }
    } catch {
      /* ignore */
    }
    return new Set(DEFAULT_GROUPS)
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const toggleGroup = (k: GroupKey) => {
    setGroups((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      try {
        localStorage.setItem(GROUP_LS_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const on = (k: GroupKey) => groups.has(k)

  /** タブ で 選んで いる セット (すべて / 未振り分け は null = 工区 の 既定) */
  const tabSet = tab === 'none' ? null : (sets.find((s) => s.id === tab) ?? null)
  const tabSlide: SurveySlide = tabSet?.slide ?? farmSlide

  /** セッション の 追加。 作ったら その タブ に 移る。 名前 は 「NNN{A,B,C}」 の
   *  デフォルト を 与える (JST 年通算日 + 同日内 の 連番) */
  const createSet = useSurveySetStore((s) => s.createSet)
  const [creatingSet, setCreatingSet] = useState(false)
  const handleCreateSet = async () => {
    setCreatingSet(true)
    try {
      const today = jstTodayIso()
      const name = generateDefaultSessionName(sets)
      const row = await createSet(farmId, { measuredOn: today, name })
      if (row) setTab(row.id)
    } finally {
      setCreatingSet(false)
    }
  }

  const [slideSaving, setSlideSaving] = useState(false)
  const [slideError, setSlideError] = useState<string | null>(null)
  /** スライド量 を 保存。 セット を 選んで いれば セット、それ 以外 は 工区 の 既定 */
  const commitSlide = async (next: SurveySlide) => {
    setSlideSaving(true)
    setSlideError(null)
    try {
      if (tabSet) {
        await updateSet(tabSet.id, { slide: next })
      } else {
        await saveSurveySlide(farmId, next)
        setFarmSlide(next)
      }
    } catch (e) {
      console.error('[mobile slide]', e)
      setSlideError(e instanceof Error ? e.message : 'スライド量 の 保存 に 失敗')
    } finally {
      setSlideSaving(false)
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[70%] flex flex-col">
      <div className="px-3 py-2 border-b flex items-center gap-2 text-sm shrink-0">
        <span className="font-semibold">実測</span>
        <span className="text-xs text-slate-500">{shown.length} 件</span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100"
          aria-label="閉じる"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* 記録セット の 切替。 セット ごと に スライド量 が 違う ので、
          どの セット を 見て いる か が 分かる よう タブ に する */}
      <div className="px-2 pt-1.5 border-b bg-slate-50 shrink-0">
        <div className="flex gap-0 overflow-x-auto">
          {[
            ...sets.map((s) => ({
              key: s.id,
              label: setLabel(s),
              n: countBySet.get(s.id) ?? 0,
            })),
            ...((countBySet.get(null) ?? 0) > 0
              ? [{ key: 'none', label: '未振り分け', n: countBySet.get(null) ?? 0 }]
              : []),
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 -mb-px border-b-2 text-xs whitespace-nowrap ${
                tab === t.key
                  ? 'border-blue-600 text-blue-700 font-medium'
                  : 'border-transparent text-slate-600'
              }`}
            >
              {t.label}
              <span className="ml-1 text-slate-400">{t.n}</span>
            </button>
          ))}
          {/* セット を 作る 入口。 名前 や 担当者 は PC で 入れる */}
          <button
            onClick={() => void handleCreateSet()}
            disabled={creatingSet}
            className="ml-auto mb-1 shrink-0 px-2 py-0.5 text-xs border rounded bg-white text-slate-600 disabled:opacity-40 flex items-center gap-1"
            title="セッション を 追加 (測量日 は 今日)"
          >
            {creatingSet ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            セッション
          </button>
        </div>
        {/* スライド量。 セット を 選んで いれば その セット、それ 以外 は 工区 の 既定。
            現場 で 基準局 を 立て 直した 直後 に 入れ たい ので ここ で 直せる ように する。 */}
        {/* スライド量 は 1 行。 直す 先 は 選んで いる タブ (セット / 工区の既定) */}
        <div className="py-1 flex items-center gap-2 text-[11px] whitespace-nowrap overflow-x-auto">
          <span className="text-slate-500 shrink-0">スライド量</span>
          {slideSaving && <Loader2 className="h-3 w-3 animate-spin text-slate-400 shrink-0" />}
          {(['dx', 'dy', 'dz'] as const).map((axis) => (
            <SlideField
              key={axis}
              label={axis === 'dx' ? 'dX' : axis === 'dy' ? 'dY' : 'dZ'}
              value={tabSlide[axis]}
              disabled={slideSaving}
              onCommit={(v) => void commitSlide({ ...tabSlide, [axis]: v })}
            />
          ))}
          {/* 出す 列 の かたまり。 dZ の 右 に 置く */}
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className={`shrink-0 px-2 py-0.5 border rounded ${
              pickerOpen ? 'bg-slate-200 border-slate-400' : 'bg-white text-slate-600'
            }`}
          >
            表示列 {groups.size}/{GROUPS.length}
          </button>
        </div>
        {pickerOpen && (
          <div className="pb-1 flex flex-wrap gap-1">
            {GROUPS.map((g) => (
              <button
                key={g.key}
                onClick={() => toggleGroup(g.key)}
                className={`px-1.5 py-0.5 text-[11px] border rounded ${
                  on(g.key)
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-500 border-slate-300'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
        {slideError && <div className="pb-1 text-[11px] text-red-600">{slideError}</div>}
      </div>

      {/* 1 行 = 1 点。 折り返す と 目 で 追えなく なる ので、はみ出す 分 は
          横 に スクロール させる。 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            {loading ? '読み込み中…' : 'この セッション の 実測記録 は ありません'}
          </div>
        ) : (
          <table className="min-w-full w-max text-[11px]">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-slate-500">
                {GROUPS.filter((g) => on(g.key)).map((g) => (
                  <th
                    key={g.key}
                    colSpan={g.key === 'design' || g.key === 'm1' || g.key === 'm2' ? 4 : 3}
                    className="px-2 py-1 text-center whitespace-nowrap border-l first:border-l-0"
                  >
                    {g.label}
                  </th>
                ))}
                <th className="px-2 py-1 text-left whitespace-nowrap border-l">日時</th>
              </tr>
              <tr className="text-slate-400">
                {GROUPS.filter((g) => on(g.key)).map((g) => {
                  const cols =
                    g.key === 'design' || g.key === 'm1' || g.key === 'm2'
                      ? ['点名', 'X', 'Y', 'Z']
                      : g.key === 'diff' || g.key === 'dvs'
                        ? ['dX', 'dY', 'dZ']
                        : ['X', 'Y', 'Z']
                  return cols.map((c, i) => (
                    <th
                      key={`${g.key}-${c}`}
                      className={`px-2 py-0.5 whitespace-nowrap ${
                        c === '点名' ? 'text-left' : 'text-right'
                      } ${i === 0 ? 'border-l first:border-l-0' : ''}`}
                    >
                      {c}
                    </th>
                  ))
                })}
                <th className="px-2 py-0.5 border-l" />
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const slide = slideOf(g.m1 ?? g.m2)
                const d = deriveRow(g, slide.dx, slide.dy, slide.dz)
                /** 数値 3 桁 の セル */
                const num = (v: number | null | undefined) => (
                  <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{f3(v)}</td>
                )
                return (
                  <tr key={g.key} className="border-t">
                    {on('design') && (
                      <>
                        <td className="px-2 py-1 whitespace-nowrap max-w-[8rem] truncate border-l first:border-l-0">
                          {g.designName || '—'}
                        </td>
                        {num(g.designX)}
                        {num(g.designY)}
                        {num(g.designZ)}
                      </>
                    )}
                    {on('m1') && (
                      <>
                        <td className="px-2 py-1 whitespace-nowrap max-w-[8rem] truncate border-l">
                          {g.m1?.targetName ?? '—'}
                          {g.m1?.pending && <span className="ml-1 text-amber-700">*</span>}
                        </td>
                        {num(g.m1?.measuredX)}
                        {num(g.m1?.measuredY)}
                        {num(g.m1?.measuredZ)}
                      </>
                    )}
                    {on('m2') && (
                      <>
                        <td className="px-2 py-1 whitespace-nowrap max-w-[8rem] truncate border-l">
                          {g.m2?.targetName ?? '—'}
                        </td>
                        {num(g.m2?.measuredX)}
                        {num(g.m2?.measuredY)}
                        {num(g.m2?.measuredZ)}
                      </>
                    )}
                    {on('diff') && (
                      <>
                        {num(d.diffX)}
                        {num(d.diffY)}
                        {num(d.diffZ)}
                      </>
                    )}
                    {on('avg') && (
                      <>
                        {num(d.avgX)}
                        {num(d.avgY)}
                        {num(d.avgZ)}
                      </>
                    )}
                    {on('dvs') && (
                      <>
                        {num(d.dvsX)}
                        {num(d.dvsY)}
                        {num(d.dvsZ)}
                      </>
                    )}
                    {on('slided') && (
                      <>
                        {num(d.slidedDX)}
                        {num(d.slidedDY)}
                        {num(d.slidedDZ)}
                      </>
                    )}
                    {on('rev') && (
                      <>
                        {num(d.revSlideMX)}
                        {num(d.revSlideMY)}
                        {num(d.revSlideMZ)}
                      </>
                    )}
                    <td className="px-2 py-1 text-slate-500 whitespace-nowrap border-l">
                      {(g.m1?.recordedAt ?? '').slice(5, 16).replace('T', ' ')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-3 py-1.5 border-t bg-slate-50 text-[11px] text-slate-500 shrink-0">
        セッション の 追加 や 記録 の 付け替え、削除 は PC の 「実測記録」 画面 から。
      </div>
    </div>
  )
}
