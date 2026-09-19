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
import {
  fetchSurveySlide,
  saveSurveySlide,
  NO_SLIDE,
  type SurveySlide,
} from '@/lib/surveyCalibration'

/** 記録 が どの 設計点 を 狙った もの か を 短く */
function targetKindLabel(r: StakingRecord): string {
  if (r.targetType === 'coordinate') return '座標'
  if (r.targetType === 'pipe_vertex') return '管'
  if (r.targetType === 'free') return '任意'
  return r.targetType
}

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
  const updateSet = useSurveySetStore((s) => s.updateSet)
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

  /** タブ で 選んで いる セット (すべて / 未振り分け は null = 工区 の 既定) */
  const tabSet = tab === 'all' || tab === 'none' ? null : (sets.find((s) => s.id === tab) ?? null)
  const tabSlide: SurveySlide = tabSet?.slide ?? farmSlide

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
        {/* スライド量。 セット を 選んで いれば その セット、それ 以外 は 工区 の 既定。
            現場 で 基準局 を 立て 直した 直後 に 入れ たい ので ここ で 直せる ように する。 */}
        <div className="py-1 flex items-center gap-2 text-[11px] flex-wrap">
          <span className="text-slate-500">
            スライド量
            <span className="ml-1 text-slate-400">
              ({tabSet ? setLabel(tabSet) : '工区の既定'})
            </span>
          </span>
          {slideSaving && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
          {(['dx', 'dy', 'dz'] as const).map((axis) => (
            <SlideField
              key={axis}
              label={axis === 'dx' ? 'dX' : axis === 'dy' ? 'dY' : 'dZ'}
              value={tabSlide[axis]}
              disabled={slideSaving}
              onCommit={(v) => void commitSlide({ ...tabSlide, [axis]: v })}
            />
          ))}
        </div>
        {tab === 'all' && sets.length > 0 && (
          <div className="pb-1 text-[10px] text-slate-400">
            「すべて」 は 工区 の 既定 を 直します。 差 の 計算 は 記録 ごと の セット の 値。
          </div>
        )}
        {slideError && <div className="pb-1 text-[11px] text-red-600">{slideError}</div>}
      </div>

      {/* 1 件 = 1 行。 折り返す と 目 で 追えなく なる ので、はみ出す 分 は
          横 に スクロール させる。 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            {loading ? '読み込み中…' : 'この セット の 実測記録 は ありません'}
          </div>
        ) : (
          <table className="min-w-full w-max text-[11px]">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-slate-500">
                <th className="px-2 py-1 text-left whitespace-nowrap">点名</th>
                <th className="px-2 py-1 text-left whitespace-nowrap">種別</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">X</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">Y</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">Z</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">水平差</th>
                <th className="px-2 py-1 text-right whitespace-nowrap">高さ差</th>
                <th className="px-2 py-1 text-left whitespace-nowrap">日時</th>
                {tab === 'all' && (
                  <th className="px-2 py-1 text-left whitespace-nowrap">セット</th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const d = deltaOf(r, slideOf(r))
                const set = r.recordSetId ? sets.find((s) => s.id === r.recordSetId) : null
                const tone =
                  d == null
                    ? 'text-slate-400'
                    : d.h <= 0.02
                      ? 'text-emerald-700'
                      : d.h <= 0.05
                        ? 'text-amber-700'
                        : 'text-red-600'
                return (
                  <tr key={r.id} className="border-t">
                    <td className="px-2 py-1 font-medium text-slate-800 whitespace-nowrap max-w-[8rem] truncate">
                      {r.targetName ?? '(点名なし)'}
                      {r.pending && <span className="ml-1 text-amber-700">*</span>}
                    </td>
                    <td className="px-2 py-1 text-slate-600 whitespace-nowrap">
                      {targetKindLabel(r)}
                      {r.surveyCategory === 'asbuilt' && (
                        <span className="ml-1 text-emerald-700">出来形</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono whitespace-nowrap">
                      {f3(r.measuredX)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono whitespace-nowrap">
                      {f3(r.measuredY)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono whitespace-nowrap">
                      {f3(r.measuredZ)}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono whitespace-nowrap ${tone}`}>
                      {d ? `${(d.h * 100).toFixed(1)}cm` : '-'}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono whitespace-nowrap ${tone}`}>
                      {d?.dz != null ? `${(d.dz * 100).toFixed(1)}cm` : '-'}
                    </td>
                    <td className="px-2 py-1 text-slate-500 whitespace-nowrap">
                      {r.recordedAt.slice(5, 16).replace('T', ' ')}
                    </td>
                    {tab === 'all' && (
                      <td className="px-2 py-1 text-slate-500 whitespace-nowrap max-w-[8rem] truncate">
                        {set ? setLabel(set) : '未振り分け'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-3 py-1.5 border-t bg-slate-50 text-[11px] text-slate-500 shrink-0">
        セット の 追加 や 記録 の 付け替え、削除 は PC の 「実測記録」 画面 から。
      </div>
    </div>
  )
}
