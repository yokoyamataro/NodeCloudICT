// 地積測量図 の 作成手順 (1〜4) の 中身。
//
//   1 対象地番        … 地番 を 選ぶ と 表題 が 入る。 地図 から も 選べる
//   2 基準点・境界情報 … 与点 の 成果 / 座標変換 の パラメータ / 境界標 の 表
//   3 図枠            … 縮尺 と 下絵 と 出力
//
// 作製者 / 申請人 の 入力 と 図枠 の 手直し は 建物図面 の 部品 を そのまま 使う。

import { useMemo, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { ParcelOption } from './floorPlanTypes'
import type { LandDrawPatch } from '@/stores/landDrawStore'
import {
  LAND_SCALES,
  MARKER_PRESETS,
  PARAM_CELL_VALUES,
  headerFromParcels,
  markerColumnsFromRows,
  markerRowsFromPoints,
  type AreaRounding,
  type LandSurveyDrawing,
  type MarkerColumn,
  type MarkerRow,
  type MarkerSymbol,
  type ParamCellValue,
} from './landDrawTypes'
import { buildLandSheet, type ControlPointForDraw, type LandParcelForDraw } from './landDrawSheet'
import { applyOverlay } from './floorPlanDraw'
import {
  buildP21,
  canvasToPdf,
  canvasToTiff,
  renderToCanvas,
  safeFileName,
  saveBlob,
} from './floorPlanExport'
import { FloorPlanSheetEditor } from './FloorPlanSheetEditor'
import { FloorPlanSiteMap } from './FloorPlanSiteMap'
import type { CoordinateConverter } from '@/lib/coordinates'
import { useLandownerStore } from '@/stores/landownerStore'
import { MakerFields } from './FloorPlanSteps'
import { BOUNDARY_KIND_LABEL, BOUNDARY_KIND_ORDER, type BoundaryKind } from '@/lib/boundaryKind'

type Patch = (patch: LandDrawPatch) => void

const inputCls = 'w-full px-2 py-1 text-sm border rounded'

/** 左 に 表題 / 右 に 入力欄 */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="w-28 shrink-0 pt-1.5 text-xs text-slate-600">{label}</div>
      <div className="flex-1 min-w-0">
        {children}
        {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
      </div>
    </div>
  )
}

/** 「251-1, 251-2」 の コンマ 区切り 文字列 を トリム して 配列化 (空 は 除外) */
function parseTitleTags(s: string | null | undefined): string[] {
  if (!s) return []
  return s
    .split(/[,、，]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function serializeTitleTags(tags: string[]): string {
  return tags.join(', ')
}

/** 図面 の 表題 と 注記。 対象地番 の 段 の 中 に 置く。
 *  地図番号 / 測量年月日 / 作製者 / 申請人 / 備考 は 「2 基準点 境界情報」 側 に 移した。 */
function InfoFields({ plan, onPatch }: { plan: LandSurveyDrawing; onPatch: Patch }) {
  const spec = plan.spec
  const setSpec = (p: Partial<typeof spec>) => onPatch({ spec: { ...spec, ...p } })

  const tags = parseTitleTags(plan.title)
  const [tagInput, setTagInput] = useState('')
  const commitTitle = (next: string[]) => {
    onPatch({ title: serializeTitleTags(next), spec: { ...spec, headerAuto: false } })
  }
  const addTag = () => {
    const t = tagInput.trim()
    if (!t) return
    if (tags.includes(t)) {
      setTagInput('')
      return
    }
    commitTitle([...tags, t])
    setTagInput('')
  }
  const removeTag = (idx: number) => {
    commitTitle(tags.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-1">
      <Field label="地番" hint="選んだ地番から自動で入ります。手入力は Enter / コンマで確定、× で削除。">
        <div className="w-full px-1.5 py-1 border rounded bg-white flex flex-wrap items-center gap-1 min-h-[32px]">
          {tags.map((t, i) => (
            <span
              key={`${t}-${i}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-slate-100 border border-slate-300 rounded"
            >
              <span className="font-mono">{t}</span>
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="text-slate-400 hover:text-red-600 leading-none"
                aria-label="削除"
                title="削除"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => {
              const v = e.target.value
              // コンマ/読点 入力 で 即 コミット
              if (/[,、，]$/.test(v)) {
                const t = v.replace(/[,、，]+$/, '').trim()
                if (t && !tags.includes(t)) commitTitle([...tags, t])
                setTagInput('')
              } else {
                setTagInput(v)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
                e.preventDefault()
                removeTag(tags.length - 1)
              }
            }}
            onBlur={() => {
              if (tagInput.trim()) addTag()
            }}
            placeholder={tags.length === 0 ? '例: 251-1' : ''}
            className="flex-1 min-w-[80px] px-1 py-0.5 text-sm bg-transparent outline-none"
          />
        </div>
      </Field>
      <Field label="土地の所在">
        <input
          className={inputCls}
          value={plan.location ?? ''}
          onChange={(e) =>
            onPatch({ location: e.target.value, spec: { ...spec, headerAuto: false } })
          }
          placeholder="例: 目梨郡羅臼町知昭町"
        />
      </Field>
      <Field label="座標系" hint="工区のプロジェクト設定から取り込んでいます。">
        <div className="flex items-center gap-1">
          <input
            type="number"
            className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
            value={spec.zone}
            onChange={(e) => setSpec({ zone: Math.max(1, Number(e.target.value) || 1) })}
          />
          <span className="text-xs text-slate-500">系</span>
        </div>
      </Field>
    </div>
  )
}

/**
 * 座標変換 の パラメータ と 観測 の 注記。
 * どちら も 基準点 に ついて の 話 な ので 「基準点・境界情報」 の 段 に 置く。
 */
function ParamFields({ plan, onPatch }: { plan: LandSurveyDrawing; onPatch: Patch }) {
  const spec = plan.spec
  const setSpec = (p: Partial<typeof spec>) => onPatch({ spec: { ...spec, ...p } })
  return (
    <div className="space-y-1 max-w-2xl">
      <div className="text-xs font-semibold text-slate-500 mb-1">
        座標変換のパラメータ（省略可）
      </div>
      <Field label="TKY2JGD">
        <input
          className={inputCls}
          value={spec.paramNote.tky2jgd}
          onChange={(e) => setSpec({ paramNote: { ...spec.paramNote, tky2jgd: e.target.value } })}
          placeholder="例: 北海道.par"
        />
      </Field>
      <Field label="PatchJGD">
        <input
          className={inputCls}
          value={spec.paramNote.patchjgd}
          onChange={(e) => setSpec({ paramNote: { ...spec.paramNote, patchjgd: e.target.value } })}
          placeholder="例: tokachi2003B"
        />
      </Field>
      {/* 基準点 / 筆界点 × TKY2JGD / PatchJGD の 4 マス。 既定 は 全部 「-」 */}
      {(() => {
        const g = spec.paramGrid ?? {
          tkyBase: '-' as ParamCellValue,
          patBase: '-' as ParamCellValue,
          tkyBoundary: '-' as ParamCellValue,
          patBoundary: '-' as ParamCellValue,
        }
        const setCell = (k: keyof NonNullable<typeof spec.paramGrid>, v: ParamCellValue) =>
          setSpec({ paramGrid: { ...g, [k]: v } })
        return (
          <Field label="適用" hint="それぞれ − / ○ / 実測 を選びます。">
            <table className="text-xs border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-1 border w-16" />
                  <th className="px-2 py-1 border w-24 font-medium">TKY2JGD</th>
                  <th className="px-2 py-1 border w-24 font-medium">PatchJGD</th>
                </tr>
              </thead>
              <tbody>
                {(['Base', 'Boundary'] as const).map((row) => (
                  <tr key={row}>
                    <td className="px-2 py-0.5 border bg-slate-50 text-center">
                      {row === 'Base' ? '基準点' : '筆界点'}
                    </td>
                    {(['tky', 'pat'] as const).map((col) => {
                      const key = `${col}${row}` as keyof NonNullable<typeof spec.paramGrid>
                      return (
                        <td key={col} className="px-1 py-0.5 border">
                          <select
                            className="w-full px-1 py-0.5 text-xs border rounded bg-white"
                            value={g[key]}
                            onChange={(e) => setCell(key, e.target.value as ParamCellValue)}
                          >
                            {PARAM_CELL_VALUES.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Field>
        )
      })()}
      <Field label="観測の注記">
        <input
          className={inputCls}
          value={spec.observationNote}
          onChange={(e) => setSpec({ observationNote: e.target.value })}
          placeholder="例: ネットワーク型RTK法による単点観測法による登記多角点の観測年月日：令和8年7月31日"
        />
      </Field>

    </div>
  )
}

/**
 * 境界標 の 表 (点 ごと の 行 UI)。
 * 列 は 「点名 / 杭種 / 新設・既設 の 別」 の 3 列。
 * 点名 と 杭種 は 選んだ 地番 の 筆界点 (design_coordinates) から 自動 で 入れ、
 * どちら も 直接 直せる。 設置区分 は 新設・入替・仮杭 → 新設、 既設 → 既設 に 寄せる。
 * 図面 側 は 「杭種 列 × 既設/新設 行」 の 形式 な ので markerColumns に 畳んで 保存。
 */
function MarkerFields({
  plan,
  parcels,
  stakeById,
  onPatch,
}: {
  plan: LandSurveyDrawing
  parcels: ParcelOption[]
  stakeById: Map<string, { stakeType: string | null; stakeStatus: string }>
  onPatch: Patch
}) {
  const spec = plan.spec
  const chosen = spec.parcelIds
  const rowsOf = (ids: string[]): MarkerRow[] => {
    const pts = ids.flatMap((id) => parcels.find((p) => p.parcelId === id)?.points ?? [])
    return markerRowsFromPoints(
      pts.map((q) => ({
        pointNumber: q.pointNumber,
        stakeType: stakeById.get(q.id)?.stakeType ?? null,
        stakeStatus: stakeById.get(q.id)?.stakeStatus ?? '',
      })),
    )
  }
  const rows: MarkerRow[] =
    spec.markerAuto === false && spec.markerRows ? spec.markerRows : rowsOf(chosen)

  const setRows = (next: MarkerRow[]) =>
    onPatch({
      spec: {
        ...spec,
        markerRows: next,
        markerColumns: markerColumnsFromRows(next),
        markerAuto: false,
      },
    })

  const resetFromParcels = () => {
    const next = rowsOf(chosen)
    onPatch({
      spec: {
        ...spec,
        markerRows: next,
        markerColumns: markerColumnsFromRows(next),
        markerAuto: true,
      },
    })
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-slate-500">
          境界標の種類及び筆界点の記号
        </span>
        <button
          type="button"
          onClick={resetFromParcels}
          className="px-2 py-0.5 text-[11px] border rounded hover:bg-slate-50"
          title="選んだ地番の筆界点から点名・杭種・区分を作り直します"
        >
          地番から取り直す
        </button>
      </div>
      <div className="text-[11px] text-slate-400 mb-1">
        1 行 = 1 点。 杭種と区分は直接書き換えられます。 区分が空の行は図面に出ません。
        {spec.markerAuto === false && (
          <span className="ml-1 text-amber-700">手入力に切り替わっています。</span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-slate-400">
          点がありません。地番を選び、座標管理で筆界点に杭種・設置状態を入れてください。
        </div>
      ) : (
        <table className="w-full text-[11px] border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-1 py-1 border text-left w-20">点名</th>
              <th className="px-1 py-1 border text-left">杭種</th>
              <th className="px-1 py-1 border text-left w-24">新設/既設</th>
              <th className="px-1 py-1 border text-left w-28">マーカー</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.pointNumber}-${i}`}>
                <td className="px-1 py-0.5 border">
                  <input
                    className="w-full px-1 py-0.5 text-[11px] border rounded font-mono"
                    value={r.pointNumber}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, k) =>
                          k === i ? { ...x, pointNumber: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    className="w-full px-1 py-0.5 text-[11px] border rounded"
                    list="marker-presets"
                    value={r.stakeType}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, k) =>
                          k === i ? { ...x, stakeType: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <select
                    className="w-full px-1 py-0.5 text-[11px] border rounded bg-white"
                    value={r.category}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, k) =>
                          k === i
                            ? { ...x, category: e.target.value as MarkerRow['category'] }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="">—</option>
                    <option value="新設">新設</option>
                    <option value="既設">既設</option>
                  </select>
                </td>
                <td className="px-1 py-0.5 border">
                  <select
                    className="w-full px-1 py-0.5 text-[11px] border rounded bg-white"
                    value={r.marker ?? 'standard'}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, k) =>
                          k === i ? { ...x, marker: e.target.value as MarkerSymbol } : x,
                        ),
                      )
                    }
                    title="図上の○マーカーの描画方法"
                  >
                    <option value="standard">あり (○)</option>
                    <option value="none">なし</option>
                    <option value="custom">個別設定 (未実装)</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <datalist id="marker-presets">
        {MARKER_PRESETS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  )
}

// ========================================================================
// 1. 対象地番 と 図面情報
// ========================================================================
export function LandStepParcels({
  plan,
  parcels,
  stakeById,
  farmId,
  zone,
  conv,
  onPatch,
}: {
  plan: LandSurveyDrawing
  parcels: ParcelOption[]
  /** 筆界点 の 杭種 と 設置状態 (境界標 の 表 を 作る ため) */
  stakeById: Map<string, { stakeType: string | null; stakeStatus: string }>
  farmId: string | null
  zone: number
  conv: CoordinateConverter
  onPatch: Patch
}) {
  const spec = plan.spec
  const chosen = spec.parcelIds

  /** 選んだ 地番 の 筆界点 から 境界標 の 行 を 作る (手入力 中 は 触らない) */
  const markerRowsOf = (ids: string[]): MarkerRow[] => {
    const pts = ids.flatMap((id) => parcels.find((p) => p.parcelId === id)?.points ?? [])
    return markerRowsFromPoints(
      pts.map((q) => ({
        pointNumber: q.pointNumber,
        stakeType: stakeById.get(q.id)?.stakeType ?? null,
        stakeStatus: stakeById.get(q.id)?.stakeStatus ?? '',
      })),
    )
  }
  /** 行 と 列 を 同時 に 返す。 既存 の patch 呼び出し に 1 行 で 流し込める */
  const markersOf = (ids: string[]): { markerRows: MarkerRow[]; markerColumns: MarkerColumn[] } => {
    if (spec.markerAuto === false) {
      return { markerRows: spec.markerRows ?? [], markerColumns: spec.markerColumns }
    }
    const r = markerRowsOf(ids)
    return { markerRows: r, markerColumns: markerColumnsFromRows(r) }
  }

  const setParcels = (ids: string[]) => {
    const picked = ids
      .map((id) => parcels.find((p) => p.parcelId === id))
      .filter((p): p is ParcelOption => p != null)
    const head = headerFromParcels(picked)
    onPatch({
      // 地番 を 選び直したら 常に 表題 を 取り直す (タグ UI の 都合 で
      // 「手入力 の 時 は 触らない」 の 旧 挙動 は 廃止。 必要 なら ×ボタン で
      // 個別 削除 or 「頭文字 追加」 で 混在 させる)。
      title: head.title,
      location: head.location || plan.location || null,
      spec: {
        ...spec,
        parcelIds: ids,
        headerAuto: true,
        // 境界標 も 同じ 扱い
        ...markersOf(ids),
      },
    })
  }
  /**
   * 筆 を 選んだ 時 に 自動 で 確定 する 筆界 種別 を 決める。
   *   - 1 種類 のみ → それ
   *   - 仮 + 確定 (他 無し) → 確定
   *   - その他 (分筆 / 合筆 を 含む 複数) → null (ダイアログ で 選択 を 促す)
   */
  const autoKindFor = (available: BoundaryKind[]): BoundaryKind | null => {
    if (available.length === 0) return null
    if (available.length === 1) return available[0]
    const set = new Set(available)
    if (available.length === 2 && set.has('provisional') && set.has('confirmed')) {
      return 'confirmed'
    }
    return null
  }

  const [kindPicker, setKindPicker] = useState<{
    parcelId: string
    label: string
    available: BoundaryKind[]
  } | null>(null)

  /** parcelIds / parcelBoundaryKinds を 同時 に 更新 する (toggle 内 で 使い回す) */
  const addParcelWithKind = (parcelId: string, kind: BoundaryKind | undefined) => {
    const nextIds = [...chosen, parcelId]
    const picked = nextIds
      .map((id) => parcels.find((p) => p.parcelId === id))
      .filter((p): p is ParcelOption => p != null)
    const head = headerFromParcels(picked)
    const nextKinds = { ...(spec.parcelBoundaryKinds ?? {}) }
    if (kind) nextKinds[parcelId] = kind
    onPatch({
      title: head.title,
      location: head.location || plan.location || null,
      spec: {
        ...spec,
        parcelIds: nextIds,
        parcelBoundaryKinds: nextKinds,
        headerAuto: true,
        ...markersOf(nextIds),
      },
    })
  }

  const toggle = (parcelId: string) => {
    if (chosen.includes(parcelId)) {
      setParcels(chosen.filter((x) => x !== parcelId))
      return
    }
    // 新規 追加 時 に 筆界 種別 を 決める
    const option = parcels.find((p) => p.parcelId === parcelId)
    const available = option?.availableKinds ?? []
    const auto = autoKindFor(available)
    if (auto !== null) {
      addParcelWithKind(parcelId, auto)
    } else {
      // 分筆 / 合筆 を 含む 複数 → ダイアログ で 選ばせる
      setKindPicker({ parcelId, label: option?.label ?? parcelId, available })
    }
  }

  // 1 筆 ごと の 筆界種別 を 変更。 空値 なら 自動 (= map から 当該 key を 削除)。
  const setParcelKind = (parcelId: string, kind: BoundaryKind | undefined) => {
    const current = { ...(spec.parcelBoundaryKinds ?? {}) }
    if (kind) current[parcelId] = kind
    else delete current[parcelId]
    // 筆界種別 が 変わる と 構成点 が 入れ替わる → 境界標 の 表 も 取り直す
    onPatch({
      spec: {
        ...spec,
        parcelBoundaryKinds: current,
        ...markersOf(chosen),
      },
    })
  }

  /** 1 筆 ごと の 地積 切捨 方式 を 変更。 既定 (floor100) に 戻す なら key を 削除。 */
  const setParcelRounding = (parcelId: string, r: AreaRounding) => {
    const current = { ...(spec.parcelAreaRounding ?? {}) }
    if (r === 'floor100') delete current[parcelId]
    else current[parcelId] = r
    onPatch({ spec: { ...spec, parcelAreaRounding: current } })
  }

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[26rem] shrink-0 flex flex-col min-h-0 overflow-auto">
        <div className="text-xs font-semibold text-slate-500 mb-1">
          対象の地番（1 筆でも数筆でも）
        </div>
        <div className="text-[11px] text-slate-400 mb-1">
          一覧のほか、右の地図の地番を押しても選べます。
        </div>
        <div className="border rounded max-h-72 overflow-auto">
          {parcels.length === 0 ? (
            <div className="p-3 text-xs text-slate-400">
              地番がありません。地番管理で取り込んでください。
            </div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-1 py-1 border w-6" />
                  <th className="px-2 py-1 border text-left">地番</th>
                  <th className="px-1 py-1 border w-10 text-right">点数</th>
                  <th className="px-1 py-1 border w-24 text-left">筆界</th>
                  <th className="px-1 py-1 border w-28 text-left">地積切捨</th>
                </tr>
              </thead>
              <tbody>
                {parcels.map((p) => {
                  const isChecked = p.parcelId != null && chosen.includes(p.parcelId)
                  const kind = p.parcelId
                    ? spec.parcelBoundaryKinds?.[p.parcelId] ?? ''
                    : ''
                  const rounding: AreaRounding =
                    (p.parcelId && spec.parcelAreaRounding?.[p.parcelId]) || 'floor100'
                  return (
                    <tr key={p.workAreaId} className={isChecked ? 'bg-blue-50/40' : ''}>
                      <td className="px-1 py-0.5 border text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => p.parcelId && toggle(p.parcelId)}
                        />
                      </td>
                      <td className="px-2 py-0.5 border truncate max-w-[9rem]">{p.label}</td>
                      <td className="px-1 py-0.5 border text-right text-slate-500 font-mono">
                        {p.points.length}
                      </td>
                      <td className="px-1 py-0.5 border">
                        {isChecked && p.parcelId ? (
                          <select
                            value={kind}
                            onChange={(e) => {
                              const v = e.target.value
                              setParcelKind(
                                p.parcelId!,
                                v === '' ? undefined : (v as BoundaryKind),
                              )
                            }}
                            className="w-full px-1 py-0.5 border rounded bg-white text-[11px]"
                          >
                            <option value="">自動</option>
                            {BOUNDARY_KIND_ORDER.map((k) => (
                              <option key={k} value={k}>
                                {BOUNDARY_KIND_LABEL[k]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-1 py-0.5 border">
                        {isChecked && p.parcelId ? (
                          <select
                            value={rounding}
                            onChange={(e) =>
                              setParcelRounding(p.parcelId!, e.target.value as AreaRounding)
                            }
                            className="w-full px-1 py-0.5 border rounded bg-white text-[11px]"
                            title="図面の「地 積」行の切り捨て方"
                          >
                            <option value="floor100">小数点2位切捨</option>
                            <option value="floor1">整数切捨</option>
                          </select>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 図面 の 表題 と 注記 */}
        <div className="mt-3 pt-3 border-t">
          <InfoFields plan={plan} onPatch={onPatch} />
        </div>

        {/* 境界標 の 表 (選んだ 地番 の 筆界点 の 杭種 から) */}
        <div className="mt-3 pt-3 border-t">
          <MarkerFields plan={plan} parcels={parcels} stakeById={stakeById} onPatch={onPatch} />
        </div>
      </div>

      {/* 地図 から も 選べる ように する (建物図面 と 同じ 地図) */}
      <div className="flex-1 min-w-0 border rounded overflow-hidden">
        <FloorPlanSiteMap
          farmId={farmId}
          zone={zone}
          conv={conv}
          rings={parcels
            .filter((p) => p.parcelId != null)
            .map((p) => ({ parcelId: p.parcelId!, label: p.label, points: p.points }))}
          chosenParcelIds={chosen}
          onToggleParcelId={(parcelId) => toggle(parcelId)}
          ring={[]}
          outline={[]}
          placed={false}
          offsetE={0}
          offsetN={0}
          rotationDeg={0}
          highlightEdge={[]}
          highlightVertex={[]}
        />
      </div>

      {/* 筆界 種別 の 選択 ダイアログ (分筆 / 合筆 を 含む 複数 の 時 だけ 出る) */}
      {kindPicker && (
        <div
          className="fixed inset-0 bg-black/40 z-[3000] flex items-center justify-center p-4"
          onClick={() => setKindPicker(null)}
        >
          <div
            className="bg-white rounded shadow-lg w-full max-w-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b">
              <div className="font-medium text-sm">筆界 の 種別 を 選択</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {kindPicker.label} に は 複数 の 筆界 が あります。 どれ を 使い ますか？
              </div>
            </div>
            <div className="p-3 space-y-1.5">
              {kindPicker.available.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    const parcelId = kindPicker.parcelId
                    setKindPicker(null)
                    addParcelWithKind(parcelId, k)
                  }}
                  className="w-full px-3 py-2 text-sm text-left border rounded hover:bg-slate-50 flex items-center justify-between"
                >
                  <span>{BOUNDARY_KIND_LABEL[k]} 筆界</span>
                  <span className="text-[10px] text-slate-400">
                    ({k === 'provisional'
                      ? '仮'
                      : k === 'confirmed'
                      ? '確定'
                      : k === 'subdivision'
                      ? '分筆'
                      : '合筆'})
                  </span>
                </button>
              ))}
            </div>
            <div className="px-3 py-2 border-t flex justify-end">
              <button
                type="button"
                onClick={() => setKindPicker(null)}
                className="px-3 py-1 text-xs border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ========================================================================
// 2. 基準点 と 境界情報
// ========================================================================
export function LandStepControls({
  plan,
  controls,
  onPatch,
}: {
  plan: LandSurveyDrawing
  controls: ControlPointForDraw[]
  onPatch: Patch
}) {
  const spec = plan.spec
  const chosen = spec.controlPointIds
  const setSpec = (p: Partial<typeof spec>) => onPatch({ spec: { ...spec, ...p } })

  // 行 の 追加 / 削除。 旧 左 リスト の 代わり に 表 の 上 の プルダウン で 選ぶ。
  const addDatum = (id: string) => {
    if (!id || chosen.includes(id)) return
    const c = controls.find((p) => p.id === id)
    if (!c) return
    onPatch({
      spec: {
        ...spec,
        controlPointIds: [...chosen, id],
        datums: [
          ...spec.datums,
          { id, category: '', name: c.pointNumber, x: c.x, y: c.y, note: '' },
        ],
      },
    })
  }
  const removeDatum = (id: string) => {
    onPatch({
      spec: {
        ...spec,
        controlPointIds: chosen.filter((x) => x !== id),
        datums: spec.datums.filter((d) => d.id !== id),
      },
    })
  }

  const setDatum = (id: string, p: Partial<(typeof spec.datums)[number]>) =>
    onPatch({
      spec: { ...spec, datums: spec.datums.map((d) => (d.id === id ? { ...d, ...p } : d)) },
    })

  const unused = controls.filter((c) => !chosen.includes(c.id))

  // 選んだ 地番 に 紐付く 地権者 を 申請人 の 選択肢 に。
  // 複数 筆 で 重複 する 地権者 は 1 件 に 絞る (full_name で dedup)。
  const landownersAll = useLandownerStore((s) => s.landowners)
  const landownersByParcelId = useLandownerStore((s) => s.landownersByParcelId)
  const landownerOptions = useMemo(() => {
    const idSet = new Set<string>()
    for (const pid of spec.parcelIds) {
      for (const lid of landownersByParcelId.get(pid) ?? []) idSet.add(lid)
    }
    const seenName = new Set<string>()
    const list: { id: string; name: string }[] = []
    for (const l of landownersAll) {
      if (!idSet.has(l.id)) continue
      const name = (l.full_name ?? '').trim()
      if (!name || seenName.has(name)) continue
      seenName.add(name)
      list.push({ id: l.id, name })
    }
    return list
  }, [landownersAll, landownersByParcelId, spec.parcelIds])

  return (
    <div className="h-full min-h-0 overflow-auto space-y-4">
      {/* 与点 の 成果 */}
      <div>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs font-semibold text-slate-500">与点の成果</span>
          <input
            className="flex-1 min-w-0 max-w-md px-2 py-1 text-xs border rounded"
            value={spec.datumTitle}
            onChange={(e) => setSpec({ datumTitle: e.target.value })}
          />
          {/* 任意列 の 表示切替。 点名/X/Y は 必須 */}
          <label className="flex items-center gap-1 text-[11px] text-slate-600 shrink-0">
            <input
              type="checkbox"
              checked={spec.datumShowCategory !== false}
              onChange={(e) => setSpec({ datumShowCategory: e.target.checked })}
            />
            区分
          </label>
          <label className="flex items-center gap-1 text-[11px] text-slate-600 shrink-0">
            <input
              type="checkbox"
              checked={spec.datumShowNote !== false}
              onChange={(e) => setSpec({ datumShowNote: e.target.checked })}
            />
            備考
          </label>
          {/* 基準点 を 行 と して 追加 (旧 左 リスト の 代替) */}
          <select
            className="px-2 py-1 text-xs border rounded shrink-0 bg-white"
            value=""
            onChange={(e) => {
              addDatum(e.target.value)
              // 選択 を 元 に 戻して 再度 同じ 候補 を 選べる ように
              e.currentTarget.value = ''
            }}
            disabled={unused.length === 0}
          >
            <option value="">
              + 基準点を追加 ({unused.length}){controls.length === 0 ? ' - 未登録' : ''}
            </option>
            {unused.map((c) => (
              <option key={c.id} value={c.id}>
                {c.pointNumber}（{c.x.toFixed(2)} / {c.y.toFixed(2)}）
              </option>
            ))}
          </select>
        </div>
        {spec.datums.length === 0 ? (
          <div className="text-xs text-slate-400">
            右上の「+ 基準点を追加」から行を入れます。区分と備考はここで書き足せます。備考は改行で 2 行に分けられます。
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-50">
              <tr>
                {spec.datumShowCategory !== false && (
                  <th className="px-2 py-1 border text-left">区分</th>
                )}
                <th className="px-2 py-1 border text-left">点名</th>
                <th className="px-2 py-1 border text-right w-28">X座標</th>
                <th className="px-2 py-1 border text-right w-28">Y座標</th>
                {spec.datumShowNote !== false && (
                  <th className="px-2 py-1 border text-left">備考</th>
                )}
                <th className="px-1 py-1 border w-8" />
              </tr>
            </thead>
            <tbody>
              {spec.datums.map((d) => (
                <tr key={d.id}>
                  {spec.datumShowCategory !== false && (
                    <td className="px-1 py-0.5 border">
                      <input
                        className="w-full px-1.5 py-1 text-xs border rounded"
                        value={d.category}
                        onChange={(e) => setDatum(d.id, { category: e.target.value })}
                        placeholder="例: 基本三角点等"
                      />
                    </td>
                  )}
                  <td className="px-1 py-0.5 border">
                    <input
                      className="w-full px-1.5 py-1 text-xs border rounded"
                      value={d.name}
                      onChange={(e) => setDatum(d.id, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-right font-mono">{d.x.toFixed(3)}</td>
                  <td className="px-1 py-0.5 border text-right font-mono">{d.y.toFixed(3)}</td>
                  {spec.datumShowNote !== false && (
                    <td className="px-1 py-0.5 border">
                      <textarea
                        rows={2}
                        className="w-full px-1.5 py-1 text-xs border rounded resize-y"
                        value={d.note}
                        onChange={(e) => setDatum(d.id, { note: e.target.value })}
                        placeholder={'ネットワーク型RTK法\nによる単点観測法'}
                        title="改行で 2 行に分けられます"
                      />
                    </td>
                  )}
                  <td className="px-1 py-0.5 border text-center">
                    <button
                      type="button"
                      onClick={() => removeDatum(d.id)}
                      className="text-slate-400 hover:text-red-600 text-sm leading-none"
                      aria-label="行を削除"
                      title="行を削除"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 座標変換 の パラメータ と 観測 の 注記 */}
      <div className="pt-3 border-t">
        <ParamFields plan={plan} onPatch={onPatch} />
      </div>

      {/* 地図番号 / 測量年月日 と 作製者 / 申請人 / 備考 (旧 Step 1 から 移設) */}
      <div className="pt-3 border-t max-w-2xl">
        <Field label="地図番号">
          <input
            className={inputCls}
            value={spec.mapNumber}
            onChange={(e) => setSpec({ mapNumber: e.target.value })}
          />
        </Field>
        <Field label="測量年月日">
          <input
            type="date"
            className={inputCls}
            value={spec.surveyedOn ?? ''}
            onChange={(e) => setSpec({ surveyedOn: e.target.value || null })}
          />
        </Field>
        <MakerFields
          frame={plan.frame}
          onFrame={(frame) => onPatch({ frame })}
          landownerOptions={landownerOptions}
        />
      </div>
    </div>
  )
}

// ========================================================================
// 3. 図枠
// ========================================================================
export function LandStepFrame({
  plan,
  parcels,
  controls,
  onPatch,
}: {
  plan: LandSurveyDrawing
  parcels: ParcelOption[]
  controls: ControlPointForDraw[]
  onPatch: Patch
}) {
  const { site, neighbors, used } = useLandSheetData(plan, parcels, controls)
  const items = useMemo(
    () => buildLandSheet(plan, site, neighbors, used),
    [plan, site, neighbors, used],
  )
  const custom = !LAND_SCALES.includes(plan.scale_denominator as (typeof LAND_SCALES)[number])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 flex-wrap pb-2 border-b">
        <span className="text-xs text-slate-600">
          用紙 <span className="ml-1 px-2 py-0.5 rounded bg-slate-100">B4 横（364 × 257 mm）</span>
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-600">
          縮尺
          {LAND_SCALES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPatch({ scale_denominator: s })}
              className={`px-2 py-1 border rounded ${
                plan.scale_denominator === s
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'hover:bg-slate-50'
              }`}
            >
              1/{s}
            </button>
          ))}
          <span className={`ml-1 ${custom ? 'text-blue-700' : 'text-slate-400'}`}>任意 1/</span>
          <input
            type="number"
            className="w-20 px-2 py-1 text-sm border rounded text-right font-mono"
            value={plan.scale_denominator}
            onChange={(e) =>
              onPatch({ scale_denominator: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        </span>
        <div className="ml-auto">
          <LandExportBar plan={plan} items={items} />
        </div>
      </div>

      <div className="flex-1 min-h-0 mt-2">
        <FloorPlanSheetEditor
          items={items}
          overlay={plan.frame.overlay}
          onChange={(overlay) => onPatch({ frame: { ...plan.frame, overlay } })}
        />
      </div>
    </div>
  )
}

/** 図面 に 渡す 地番 と 基準点 を 束ねる */
function useLandSheetData(
  plan: LandSurveyDrawing,
  parcels: ParcelOption[],
  controls: ControlPointForDraw[],
) {
  const site: LandParcelForDraw[] = useMemo(
    () =>
      plan.spec.parcelIds
        .map((id) => parcels.find((p) => p.parcelId === id))
        .filter((p): p is ParcelOption => p != null)
        .map((p) => ({ parcelId: p.parcelId ?? undefined, label: p.label, points: p.points })),
    [plan.spec.parcelIds, parcels],
  )
  const neighbors: LandParcelForDraw[] = useMemo(
    () =>
      parcels
        .filter((p) => p.parcelId != null && !plan.spec.parcelIds.includes(p.parcelId))
        .map((p) => ({ parcelId: p.parcelId ?? undefined, label: p.label, points: p.points })),
    [parcels, plan.spec.parcelIds],
  )
  const used = useMemo(
    () => controls.filter((c) => plan.spec.controlPointIds.includes(c.id)),
    [controls, plan.spec.controlPointIds],
  )
  return { site, neighbors, used }
}

/** 成果 の 書き出し。 仕組み は 建物図面 と 同じ */
function LandExportBar({
  plan,
  items,
}: {
  plan: LandSurveyDrawing
  items: ReturnType<typeof buildLandSheet>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const base = safeFileName(plan.title || plan.location || '地積測量図')

  const run = async (kind: 'p21' | 'tif' | 'pdf') => {
    setBusy(kind)
    setNote(null)
    try {
      const drawn = applyOverlay(items, plan.frame.overlay)
      if (kind === 'p21') {
        saveBlob(
          new Blob([buildP21(drawn, base)], { type: 'application/octet-stream' }),
          `${base}.p21`,
        )
      } else {
        const cv = renderToCanvas(drawn, 400)
        if (kind === 'tif') saveBlob(canvasToTiff(cv, 400), `${base}.tif`)
        else saveBlob(await canvasToPdf(cv), `${base}.pdf`)
      }
      setNote('書き出しました。')
    } catch (e) {
      setNote(e instanceof Error ? e.message : '書き出せませんでした。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">成果の出力</span>
        {(['p21', 'tif', 'pdf'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => void run(k)}
            disabled={busy != null}
            className="px-3 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
          >
            {busy === k ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {k.toUpperCase()}
          </button>
        ))}
      </div>
      {note && (
        <div className="absolute right-0 top-full mt-1 px-2 py-1 rounded bg-slate-800 text-white text-[11px] whitespace-nowrap shadow">
          {note}
        </div>
      )}
    </div>
  )
}
