// 地積測量図 の 作成手順 (1〜4) の 中身。
//
//   1 図面情報 … 地図番号 / 所在 / 作製者 / 申請人
//   2 対象地番 … 1 筆 でも 数筆 でも
//   3 基準点   … 与点 の 成果 に 載せる 点
//   4 図枠     … 縮尺 と 下絵 と 出力
//
// 作製者 / 申請人 の 入力 と 図枠 の 手直し は 建物図面 の 部品 を そのまま 使う。

import { useMemo, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { ParcelOption } from './floorPlanTypes'
import type { LandDrawPatch } from '@/stores/landDrawStore'
import {
  LAND_SCALES,
  MARKER_PRESETS,
  headerFromParcels,
  markersFromPoints,
  type LandSurveyDrawing,
  type MarkerColumn,
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
import { MakerFields } from './FloorPlanSteps'

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

/** 図面 の 表題 と 注記。 対象地番 の 段 の 中 に 置く */
function InfoFields({ plan, onPatch }: { plan: LandSurveyDrawing; onPatch: Patch }) {
  const spec = plan.spec
  const setSpec = (p: Partial<typeof spec>) => onPatch({ spec: { ...spec, ...p } })

  return (
    <div className="space-y-1">
      <Field label="地番" hint="選んだ地番から入ります。直すと以後は自動で書き換えません。">
        <input
          className={inputCls}
          value={plan.title ?? ''}
          onChange={(e) =>
            onPatch({ title: e.target.value, spec: { ...spec, headerAuto: false } })
          }
          placeholder="例: 251-1, 251-2"
        />
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

      <div className="pt-3 mt-2 border-t text-xs font-semibold text-slate-500">
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
      <Field label="観測の注記">
        <input
          className={inputCls}
          value={spec.observationNote}
          onChange={(e) => setSpec({ observationNote: e.target.value })}
          placeholder="例: ネットワーク型RTK法による単点観測法による登記多角点の観測年月日：令和8年7月31日"
        />
      </Field>

      {/* 作製者 / 申請人 は 建物図面 と 同じ 部品 */}
      <MakerFields
        frame={plan.frame}
        onFrame={(frame) => onPatch({ frame })}
      />
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

  /** 選んだ 地番 の 筆界点 から 境界標 の 表 を 作る */
  const markersOf = (ids: string[]): MarkerColumn[] => {
    const pts = ids.flatMap((id) => parcels.find((p) => p.parcelId === id)?.points ?? [])
    return markersFromPoints(
      pts.map((q) => ({
        pointNumber: q.pointNumber,
        stakeType: stakeById.get(q.id)?.stakeType ?? null,
        stakeStatus: stakeById.get(q.id)?.stakeStatus ?? '',
      })),
    )
  }

  const setParcels = (ids: string[]) => {
    const picked = ids
      .map((id) => parcels.find((p) => p.parcelId === id))
      .filter((p): p is ParcelOption => p != null)
    const head = headerFromParcels(picked)
    onPatch({
      // 地番 を 変えたら 表題 も 取り直す (手 で 直して いた 場合 は そのまま)
      ...(spec.headerAuto === false
        ? {}
        : { title: head.title, location: head.location || null }),
      spec: {
        ...spec,
        parcelIds: ids,
        // 境界標 も 同じ 扱い
        markerColumns: spec.markerAuto === false ? spec.markerColumns : markersOf(ids),
      },
    })
  }
  const toggle = (parcelId: string) =>
    setParcels(
      chosen.includes(parcelId) ? chosen.filter((x) => x !== parcelId) : [...chosen, parcelId],
    )

  const setMarkers = (cols: MarkerColumn[]) =>
    onPatch({ spec: { ...spec, markerColumns: cols, markerAuto: false } })

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-[21rem] shrink-0 flex flex-col min-h-0 overflow-auto">
        <div className="text-xs font-semibold text-slate-500 mb-1">
          対象の地番（1 筆でも数筆でも）
        </div>
        <div className="text-[11px] text-slate-400 mb-1">
          一覧のほか、右の地図の地番を押しても選べます。
        </div>
        <ul className="border rounded divide-y max-h-56 overflow-auto">
          {parcels.length === 0 && (
            <li className="p-3 text-xs text-slate-400">
              地番がありません。地番管理で取り込んでください。
            </li>
          )}
          {parcels.map((p) => (
            <li key={p.workAreaId}>
              <label className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={p.parcelId != null && chosen.includes(p.parcelId)}
                  onChange={() => p.parcelId && toggle(p.parcelId)}
                />
                <span className="flex-1 min-w-0 truncate">{p.label}</span>
                <span className="text-[11px] text-slate-400">{p.points.length} 点</span>
              </label>
            </li>
          ))}
        </ul>

        {/* 境界標 の 表。 選んだ 地番 の 杭種 から 作る */}
        <div className="mt-3 pt-3 border-t">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-slate-500">
              境界標の種類及び筆界点の記号
            </span>
            <button
              type="button"
              onClick={() =>
                onPatch({ spec: { ...spec, markerColumns: markersOf(chosen), markerAuto: true } })
              }
              className="px-2 py-0.5 text-[11px] border rounded hover:bg-slate-50"
              title="選んだ地番の杭種・設置状態から作り直します"
            >
              地番から取り直す
            </button>
          </div>
          <div className="text-[11px] text-slate-400 mb-1">
            杭種が列、設置状態（既設／新設・入替）が行になります。
            {spec.markerAuto === false && (
              <span className="ml-1 text-amber-700">手入力に切り替わっています。</span>
            )}
          </div>
          {spec.markerColumns.length === 0 ? (
            <div className="text-[11px] text-slate-400">
              杭種・設置状態が入っていません。座標管理で筆界点に設定してください。
            </div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-1 py-1 border w-10" />
                  {spec.markerColumns.map((c) => (
                    <th key={c.id} className="px-1 py-1 border font-medium">
                      <input
                        className="w-full px-1 py-0.5 text-[11px] border rounded"
                        list="marker-presets"
                        value={c.kind}
                        onChange={(e) =>
                          setMarkers(
                            spec.markerColumns.map((x) =>
                              x.id === c.id ? { ...x, kind: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['existing', 'created'] as const).map((row) => (
                  <tr key={row}>
                    <td className="px-1 py-1 border bg-slate-50 text-center">
                      {row === 'existing' ? '既設' : '新設'}
                    </td>
                    {spec.markerColumns.map((c) => (
                      <td key={c.id} className="px-1 py-0.5 border">
                        <input
                          className="w-full px-1 py-0.5 text-[11px] border rounded"
                          value={c[row]}
                          onChange={(e) =>
                            setMarkers(
                              spec.markerColumns.map((x) =>
                                x.id === c.id ? { ...x, [row]: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                    ))}
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

        {/* 図面 の 表題 と 注記、作製者 / 申請人 */}
        <div className="mt-3 pt-3 border-t">
          <InfoFields plan={plan} onPatch={onPatch} />
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
    </div>
  )
}

// ========================================================================
// 3. 基準点
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

  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]
    // 表 の 行 も 合わせる (既に 手 で 直した 行 は 残す)
    const keep = spec.datums.filter((d) => next.includes(d.id))
    const added = next
      .filter((x) => !keep.some((d) => d.id === x))
      .map((x) => {
        const c = controls.find((p) => p.id === x)!
        return { id: x, category: '', name: c.pointNumber, x: c.x, y: c.y, note: '' }
      })
    onPatch({ spec: { ...spec, controlPointIds: next, datums: [...keep, ...added] } })
  }

  const setDatum = (id: string, p: Partial<(typeof spec.datums)[number]>) =>
    onPatch({
      spec: { ...spec, datums: spec.datums.map((d) => (d.id === id ? { ...d, ...p } : d)) },
    })

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-72 shrink-0 flex flex-col min-h-0">
        <div className="text-xs font-semibold text-slate-500 mb-1">使用した基準点</div>
        <ul className="border rounded divide-y overflow-auto flex-1 min-h-0">
          {controls.length === 0 && (
            <li className="p-3 text-xs text-slate-400">
              基準点がありません。座標管理で点種を「基準点」にしてください。
            </li>
          )}
          {controls.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  onChange={() => toggle(c.id)}
                />
                <span className="flex-1 min-w-0 truncate">{c.pointNumber}</span>
                <span className="text-[10px] text-slate-400 font-mono">
                  {c.x.toFixed(2)} / {c.y.toFixed(2)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-slate-500">与点の成果</span>
          <input
            className="flex-1 min-w-0 max-w-md px-2 py-1 text-xs border rounded"
            value={spec.datumTitle}
            onChange={(e) => onPatch({ spec: { ...spec, datumTitle: e.target.value } })}
          />
        </div>
        {spec.datums.length === 0 ? (
          <div className="text-xs text-slate-400">
            基準点を選ぶと表に入ります。区分と備考はここで書き足せます。備考は改行で 2 行に分けられます。
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-1 border text-left">区分</th>
                <th className="px-2 py-1 border text-left">点名</th>
                <th className="px-2 py-1 border text-right w-28">X座標</th>
                <th className="px-2 py-1 border text-right w-28">Y座標</th>
                <th className="px-2 py-1 border text-left">備考</th>
              </tr>
            </thead>
            <tbody>
              {spec.datums.map((d) => (
                <tr key={d.id}>
                  <td className="px-1 py-0.5 border">
                    <input
                      className="w-full px-1.5 py-1 text-xs border rounded"
                      value={d.category}
                      onChange={(e) => setDatum(d.id, { category: e.target.value })}
                      placeholder="例: 基本三角点等"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      className="w-full px-1.5 py-1 text-xs border rounded"
                      value={d.name}
                      onChange={(e) => setDatum(d.id, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-right font-mono">{d.x.toFixed(3)}</td>
                  <td className="px-1 py-0.5 border text-right font-mono">{d.y.toFixed(3)}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ========================================================================
// 4. 図枠
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
        .map((p) => ({ label: p.label, points: p.points })),
    [plan.spec.parcelIds, parcels],
  )
  const neighbors: LandParcelForDraw[] = useMemo(
    () =>
      parcels
        .filter((p) => p.parcelId != null && !plan.spec.parcelIds.includes(p.parcelId))
        .map((p) => ({ label: p.label, points: p.points })),
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
