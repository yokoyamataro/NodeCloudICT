// 09 筆界位置の計測 (上半)
//   * 座標系 (世界測地系 / 独自)
//   * 使用機器 (TS / GNSS / その他)
//   * 観測方法 (放射 / 結合 / 閉合 / 交会 / … + GNSS 観測方法)
//   * 観測期間
//   * 基本三角点等 / 補助基準点 / 恒久的地物 (可変行)
//   * 写真 1 / 写真 2
//   * 基本三角点測量ができない理由 (自由文 + 定型文)

import { useState } from 'react'
import { Plus, Trash2, ListChecks } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import type {
  LandReportBody,
  ReportBasePoint,
  ReportPermanentFeature,
} from '@/stores/landReportStore'
import { CheckboxLabel, Field, SnippetPickerButton } from './reportSectionUi'
import { CoordinatePickerModal, type PickableCoordinate } from './CoordinatePickerModal'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyBase = (): ReportBasePoint => ({
  coordinateId: null,
  name: '',
  grade: '',
  mark: '',
})

const emptyFeature = (): ReportPermanentFeature => ({
  coordinateId: null,
  name: '',
  featureName: '',
  objectName: '',
})

type BasePointField = 'basePoints' | 'subBasePoints'

export function ReportSectionBoundary({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [pickerFor, setPickerFor] = useState<BasePointField | null>(null)
  const b = body.boundary

  const patch = (p: Partial<LandReportBody['boundary']>) => {
    onChange({ boundary: { ...b, ...p } })
  }
  const patchCoord = (p: Partial<LandReportBody['boundary']['coordSystem']>) => {
    patch({ coordSystem: { ...b.coordSystem, ...p } })
  }
  const patchDevices = (p: Partial<LandReportBody['boundary']['devices']>) => {
    patch({ devices: { ...b.devices, ...p } })
  }
  const patchMethods = (p: Partial<LandReportBody['boundary']['methods']>) => {
    patch({ methods: { ...b.methods, ...p } })
  }

  const patchBasePoints = (idx: number, p: Partial<ReportBasePoint>) => {
    patch({
      basePoints: b.basePoints.map((r, i) => (i === idx ? { ...r, ...p } : r)),
    })
  }
  const patchSubBasePoints = (idx: number, p: Partial<ReportBasePoint>) => {
    patch({
      subBasePoints: b.subBasePoints.map((r, i) => (i === idx ? { ...r, ...p } : r)),
    })
  }
  const patchFeatures = (idx: number, p: Partial<ReportPermanentFeature>) => {
    patch({
      permanentFeatures: b.permanentFeatures.map((r, i) => (i === idx ? { ...r, ...p } : r)),
    })
  }

  return (
    <div className="p-3 space-y-3">
      {/* 座標系 */}
      <div className="border rounded p-2">
        <div className="text-xs font-semibold text-slate-700 mb-1">座標系</div>
        <div className="flex items-center gap-3 flex-wrap">
          <CheckboxLabel
            checked={b.coordSystem.isWorld}
            onChange={(v) => patchCoord({ isWorld: v })}
          >
            世界測地系
          </CheckboxLabel>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-500">変換パラメータ:</span>
            <input
              type="text"
              value={b.coordSystem.converterParam}
              onChange={(e) => patchCoord({ converterParam: e.target.value })}
              className="px-2 py-1 text-xs border rounded w-40"
              placeholder="TKY2JGD 等"
            />
          </div>
          <CheckboxLabel
            checked={b.coordSystem.isCustom}
            onChange={(v) => patchCoord({ isCustom: v })}
          >
            独自座標系
          </CheckboxLabel>
          {b.coordSystem.isCustom && (
            <input
              type="text"
              value={b.coordSystem.customLabel}
              onChange={(e) => patchCoord({ customLabel: e.target.value })}
              placeholder="独自座標系の名称"
              className="px-2 py-1 text-xs border rounded flex-1 min-w-32"
            />
          )}
        </div>
      </div>

      {/* 使用機器 */}
      <div className="border rounded p-2">
        <div className="text-xs font-semibold text-slate-700 mb-1">使用機器</div>
        <div className="flex items-center gap-3 flex-wrap">
          <CheckboxLabel checked={b.devices.ts} onChange={(v) => patchDevices({ ts: v })}>
            トータルステーション (TS)
          </CheckboxLabel>
          <CheckboxLabel checked={b.devices.gnss} onChange={(v) => patchDevices({ gnss: v })}>
            GNSS
          </CheckboxLabel>
          <CheckboxLabel checked={b.devices.other} onChange={(v) => patchDevices({ other: v })}>
            その他
          </CheckboxLabel>
          {b.devices.other && (
            <input
              type="text"
              value={b.devices.otherText}
              onChange={(e) => patchDevices({ otherText: e.target.value })}
              placeholder="機器名"
              className="px-2 py-1 text-xs border rounded flex-1 min-w-32"
            />
          )}
        </div>
      </div>

      {/* 観測方法 */}
      <div className="border rounded p-2">
        <div className="text-xs font-semibold text-slate-700 mb-1">観測方法 (TS)</div>
        <div className="grid grid-cols-3 md:grid-cols-4 gap-1">
          <CheckboxLabel checked={b.methods.radial} onChange={(v) => patchMethods({ radial: v })}>放射法</CheckboxLabel>
          <CheckboxLabel checked={b.methods.closing} onChange={(v) => patchMethods({ closing: v })}>結合トラバース</CheckboxLabel>
          <CheckboxLabel checked={b.methods.loop} onChange={(v) => patchMethods({ loop: v })}>閉合トラバース</CheckboxLabel>
          <CheckboxLabel checked={b.methods.intersection} onChange={(v) => patchMethods({ intersection: v })}>交会法</CheckboxLabel>
          <CheckboxLabel checked={b.methods.single} onChange={(v) => patchMethods({ single: v })}>単路線</CheckboxLabel>
          <CheckboxLabel checked={b.methods.opposite} onChange={(v) => patchMethods({ opposite: v })}>対辺観測</CheckboxLabel>
          <CheckboxLabel checked={b.methods.average} onChange={(v) => patchMethods({ average: v })}>平均計算</CheckboxLabel>
          <CheckboxLabel checked={b.methods.other} onChange={(v) => patchMethods({ other: v })}>その他</CheckboxLabel>
        </div>
        {b.methods.other && (
          <input
            type="text"
            value={b.methods.otherText}
            onChange={(e) => patchMethods({ otherText: e.target.value })}
            placeholder="その他の観測方法"
            className="mt-1 w-full px-2 py-1 text-xs border rounded"
          />
        )}

        <div className="text-xs font-semibold text-slate-700 mt-3 mb-1">観測方法 (GNSS)</div>
        <div className="grid grid-cols-3 md:grid-cols-4 gap-1">
          <CheckboxLabel checked={b.methods.static} onChange={(v) => patchMethods({ static: v })}>スタティック</CheckboxLabel>
          <CheckboxLabel checked={b.methods.shortStatic} onChange={(v) => patchMethods({ shortStatic: v })}>短縮スタティック</CheckboxLabel>
          <CheckboxLabel checked={b.methods.rtk} onChange={(v) => patchMethods({ rtk: v })}>RTK-GNSS</CheckboxLabel>
          <CheckboxLabel checked={b.methods.networkRtk} onChange={(v) => patchMethods({ networkRtk: v })}>ネットワーク型 RTK</CheckboxLabel>
          <CheckboxLabel checked={b.methods.gnssOther} onChange={(v) => patchMethods({ gnssOther: v })}>その他</CheckboxLabel>
        </div>
        {b.methods.gnssOther && (
          <input
            type="text"
            value={b.methods.gnssOtherText}
            onChange={(e) => patchMethods({ gnssOtherText: e.target.value })}
            placeholder="その他の GNSS 観測方法"
            className="mt-1 w-full px-2 py-1 text-xs border rounded"
          />
        )}
      </div>

      {/* 観測期間 */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="観測開始">
          <input
            type="date"
            value={b.observationStart}
            onChange={(e) => patch({ observationStart: e.target.value })}
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </Field>
        <Field label="観測終了">
          <input
            type="date"
            value={b.observationEnd}
            onChange={(e) => patch({ observationEnd: e.target.value })}
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </Field>
      </div>

      {/* 基本三角点等 */}
      <BasePointTable
        title="基本三角点等"
        rows={b.basePoints}
        onPatch={patchBasePoints}
        onAdd={() => patch({ basePoints: [...b.basePoints, emptyBase()] })}
        onRemove={(idx) => patch({ basePoints: b.basePoints.filter((_, i) => i !== idx) })}
        onPickFromCoords={currentFarm?.id ? () => setPickerFor('basePoints') : undefined}
      />

      {/* 補助基準点 */}
      <BasePointTable
        title="補助基準点"
        rows={b.subBasePoints}
        onPatch={patchSubBasePoints}
        onAdd={() => patch({ subBasePoints: [...b.subBasePoints, emptyBase()] })}
        onRemove={(idx) => patch({ subBasePoints: b.subBasePoints.filter((_, i) => i !== idx) })}
        onPickFromCoords={currentFarm?.id ? () => setPickerFor('subBasePoints') : undefined}
      />

      {/* 恒久的地物 */}
      <div className="border rounded p-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-semibold text-slate-700">恒久的地物</div>
          <button
            type="button"
            onClick={() => patch({ permanentFeatures: [...b.permanentFeatures, emptyFeature()] })}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs border rounded hover:bg-slate-50"
          >
            <Plus className="h-3 w-3" /> 行を追加
          </button>
        </div>
        {b.permanentFeatures.length === 0 ? (
          <div className="text-xs text-slate-400">なし</div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-1 py-1 border text-left w-24">点名</th>
                <th className="px-1 py-1 border text-left">名称・種別</th>
                <th className="px-1 py-1 border text-left">地物の名称</th>
                <th className="w-8 border"></th>
              </tr>
            </thead>
            <tbody>
              {b.permanentFeatures.map((r, idx) => (
                <tr key={idx}>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.name}
                      onChange={(e) => patchFeatures(idx, { name: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.featureName}
                      onChange={(e) => patchFeatures(idx, { featureName: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.objectName}
                      onChange={(e) => patchFeatures(idx, { objectName: e.target.value })}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-center">
                    <button
                      type="button"
                      onClick={() => patch({ permanentFeatures: b.permanentFeatures.filter((_, i) => i !== idx) })}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 写真 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="border rounded p-2">
          <div className="text-xs font-semibold text-slate-700 mb-1">写真 1</div>
          <div className="grid grid-cols-1 gap-2">
            <Field label="撮影日">
              <input
                type="date"
                value={b.photo1.date}
                onChange={(e) => patch({ photo1: { ...b.photo1, date: e.target.value } })}
                className="w-full px-2 py-1 text-xs border rounded"
              />
            </Field>
            <Field label="備考">
              <input
                type="text"
                value={b.photo1.remark}
                onChange={(e) => patch({ photo1: { ...b.photo1, remark: e.target.value } })}
                className="w-full px-2 py-1 text-xs border rounded"
              />
            </Field>
          </div>
        </div>
        <div className="border rounded p-2">
          <div className="text-xs font-semibold text-slate-700 mb-1">写真 2</div>
          <div className="grid grid-cols-1 gap-2">
            <Field label="撮影日">
              <input
                type="date"
                value={b.photo2.date}
                onChange={(e) => patch({ photo2: { ...b.photo2, date: e.target.value } })}
                className="w-full px-2 py-1 text-xs border rounded"
              />
            </Field>
            <Field label="備考">
              <input
                type="text"
                value={b.photo2.remark}
                onChange={(e) => patch({ photo2: { ...b.photo2, remark: e.target.value } })}
                className="w-full px-2 py-1 text-xs border rounded"
              />
            </Field>
          </div>
        </div>
      </div>

      {pickerFor && currentFarm?.id && (
        <CoordinatePickerModal
          farmId={currentFarm.id}
          alreadyIn={new Set(b[pickerFor].map((r) => r.coordinateId).filter(Boolean) as string[])}
          title={pickerFor === 'basePoints' ? '基本三角点等を選択' : '補助基準点を選択'}
          onCancel={() => setPickerFor(null)}
          onConfirm={(picked: PickableCoordinate[]) => {
            const additions: ReportBasePoint[] = picked.map((p) => ({
              coordinateId: p.id,
              name: p.pointNumber,
              grade: p.type ?? '',
              mark: p.stakeType ?? '',
            }))
            patch({ [pickerFor]: [...b[pickerFor], ...additions] } as Partial<LandReportBody['boundary']>)
            setPickerFor(null)
          }}
        />
      )}

      {/* 基本三角点測量ができない理由 */}
      <div className="border rounded p-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-semibold text-slate-700">
            基本三角点等に基づく測量ができない理由
          </div>
          <div className="ml-auto">
            <SnippetPickerButton
              category="no_triangulation_reason"
              onInsert={(t) => patch({
                noBaseTriangulationReason: b.noBaseTriangulationReason
                  ? `${b.noBaseTriangulationReason}\n${t}`
                  : t,
              })}
            />
          </div>
        </div>
        <textarea
          value={b.noBaseTriangulationReason}
          onChange={(e) => patch({ noBaseTriangulationReason: e.target.value })}
          rows={3}
          className="w-full px-2 py-1 text-xs border rounded"
          placeholder="基本三角点が近傍にない場合など"
        />
      </div>
    </div>
  )
}

interface BasePointTableProps {
  title: string
  rows: ReportBasePoint[]
  onPatch: (idx: number, p: Partial<ReportBasePoint>) => void
  onAdd: () => void
  onRemove: (idx: number) => void
  onPickFromCoords?: () => void
}

function BasePointTable({ title, rows, onPatch, onAdd, onRemove, onPickFromCoords }: BasePointTableProps) {
  return (
    <div className="border rounded p-2">
      <div className="flex items-center gap-2 mb-1">
        <div className="text-xs font-semibold text-slate-700">{title}</div>
        <div className="ml-auto flex items-center gap-1">
          {onPickFromCoords && (
            <button
              type="button"
              onClick={onPickFromCoords}
              className="flex items-center gap-1 px-2 py-0.5 text-xs border rounded hover:bg-slate-50"
            >
              <ListChecks className="h-3 w-3" /> 座標から選択
            </button>
          )}
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 px-2 py-0.5 text-xs border rounded hover:bg-slate-50"
          >
            <Plus className="h-3 w-3" /> 手動追加
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-400">なし</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-1 py-1 border text-left w-32">点名</th>
              <th className="px-1 py-1 border text-left w-32">等級・種別</th>
              <th className="px-1 py-1 border text-left">標識 (杭種)</th>
              <th className="w-8 border"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.name}
                    onChange={(e) => onPatch(idx, { name: e.target.value })}
                    className="w-full px-1 py-0.5 border rounded"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.grade}
                    onChange={(e) => onPatch(idx, { grade: e.target.value })}
                    className="w-full px-1 py-0.5 border rounded"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.mark}
                    onChange={(e) => onPatch(idx, { mark: e.target.value })}
                    className="w-full px-1 py-0.5 border rounded"
                  />
                </td>
                <td className="px-1 py-0.5 border text-center">
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
