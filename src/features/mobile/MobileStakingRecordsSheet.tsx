// スマホ の 実測一覧。
//
// PC の 実測記録 画面 (StakingRecordsPage) を そのまま 出す と 横 に 広すぎる ので、
// 現場 で 見たい もの だけ を 縦 の リスト に する:
//   ・記録セット の 切替 (タブ) と、その セット の スライド量
//   ・点名 / 種別 / 実測 の X・Y・Z / 設計 との 差 / 測った 時刻
//
// 直す のは PC に 任せる。 ここ は 「今 どこ まで 測った か」 「どの セット で
// 測った か」 を 確かめる ため の 画面。

import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useStakingStore, type StakingRecord } from '@/stores/stakingStore'
import { setLabel, useSurveySetStore } from '@/stores/surveySetStore'
import { fetchSurveySlide, NO_SLIDE, type SurveySlide } from '@/lib/surveyCalibration'

/** 記録 が どの 設計点 を 狙った もの か を 短く */
function targetKindLabel(r: StakingRecord): string {
  if (r.targetType === 'coordinate') return '座標'
  if (r.targetType === 'pipe_vertex') return '管'
  if (r.targetType === 'free') return '任意'
  return r.targetType
}

const f3 = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(3))

/** 設計 と 実測 の 差 (m)。 設計 が 無い 記録 は null */
function deltaOf(r: StakingRecord, slide: SurveySlide) {
  if (r.targetX == null || r.targetY == null) return null
  // 実測 − スライド量 で 設計 の 土俵 に 乗せて から 比べる
  const dx = r.measuredX - slide.dx - r.targetX
  const dy = r.measuredY - slide.dy - r.targetY
  const dz =
    r.measuredZ == null || r.targetZ == null ? null : r.measuredZ - slide.dz - r.targetZ
  return { dx, dy, dz, h: Math.hypot(dx, dy) }
}

export function MobileStakingRecordsSheet({
  farmId,
  onClose,
}: {
  farmId: string
  onClose: () => void
}) {
  const records = useStakingStore((s) => s.records)
  const loading = useStakingStore((s) => s.loading)
  const fetchRecords = useStakingStore((s) => s.fetchRecords)
  const sets = useSurveySetStore((s) => s.sets)
  const fetchSets = useSurveySetStore((s) => s.fetchByFarm)
  /** 工区 単位 の スライド量。 セット に 属さない 記録 は これ で 見る */
  const [farmSlide, setFarmSlide] = useState<SurveySlide>(NO_SLIDE)
  const [tab, setTab] = useState<string>('all')

  useEffect(() => {
    void fetchRecords(farmId)
    void fetchSets(farmId)
    void fetchSurveySlide(farmId).then(setFarmSlide)
  }, [farmId, fetchRecords, fetchSets])

  const mine = useMemo(
    () => records.filter((r) => r.farmId === farmId),
    [records, farmId],
  )
  const slideOf = (r: StakingRecord): SurveySlide =>
    (r.recordSetId ? sets.find((s) => s.id === r.recordSetId)?.slide : undefined) ?? farmSlide

  const countBySet = useMemo(() => {
    const m = new Map<string | null, number>()
    for (const r of mine) {
      const k = r.recordSetId ?? null
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [mine])

  const shown = useMemo(() => {
    const base =
      tab === 'all'
        ? mine
        : tab === 'none'
          ? mine.filter((r) => !r.recordSetId)
          : mine.filter((r) => r.recordSetId === tab)
    // 新しい 順。 現場 では 直前 に 測った もの を 見たい
    return [...base].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  }, [mine, tab])

  /** タブ で 選んで いる セット の スライド量 (すべて / 未振り分け は 工区 の 値) */
  const tabSlide: SurveySlide =
    tab === 'all' || tab === 'none'
      ? farmSlide
      : (sets.find((s) => s.id === tab)?.slide ?? farmSlide)

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
            { key: 'all', label: 'すべて', n: mine.length },
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
        </div>
        <div className="py-1 text-[11px] text-slate-500 font-mono">
          スライド量 dX {tabSlide.dx.toFixed(3)} / dY {tabSlide.dy.toFixed(3)} / dZ{' '}
          {tabSlide.dz.toFixed(3)}
          {tab === 'all' && sets.length > 0 && (
            <span className="ml-1 font-sans text-slate-400">
              (すべて は 工区 の 値。 差 は 記録 ごと の セット で 補正)
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            {loading ? '読み込み中…' : 'この セット の 実測記録 は ありません'}
          </div>
        ) : (
          <ul className="divide-y">
            {shown.map((r) => {
              const d = deltaOf(r, slideOf(r))
              const set = r.recordSetId ? sets.find((s) => s.id === r.recordSetId) : null
              return (
                <li key={r.id} className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {r.targetName ?? '(点名なし)'}
                    </span>
                    <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-600 shrink-0">
                      {targetKindLabel(r)}
                    </span>
                    {r.surveyCategory === 'asbuilt' && (
                      <span className="text-[10px] px-1 rounded bg-emerald-100 text-emerald-700 shrink-0">
                        出来形
                      </span>
                    )}
                    {r.pending && (
                      <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-800 shrink-0">
                        未送信
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400 shrink-0">
                      {r.recordedAt.slice(5, 16).replace('T', ' ')}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] font-mono text-slate-600">
                    <span>X {f3(r.measuredX)}</span>
                    <span>Y {f3(r.measuredY)}</span>
                    <span>Z {f3(r.measuredZ)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    {d ? (
                      <span
                        className={`font-mono ${
                          d.h <= 0.02 ? 'text-emerald-700' : d.h <= 0.05 ? 'text-amber-700' : 'text-red-600'
                        }`}
                      >
                        差 水平 {(d.h * 100).toFixed(1)}cm
                        {d.dz != null && ` / 高さ ${(d.dz * 100).toFixed(1)}cm`}
                      </span>
                    ) : (
                      <span className="text-slate-400">設計点 なし</span>
                    )}
                    {tab === 'all' && (
                      <span className="ml-auto text-[10px] text-slate-400 truncate">
                        {set ? setLabel(set) : '未振り分け'}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="px-3 py-1.5 border-t bg-slate-50 text-[11px] text-slate-500 shrink-0">
        セット の 追加 や 記録 の 付け替え、削除 は PC の 「実測記録」 画面 から。
      </div>
    </div>
  )
}
