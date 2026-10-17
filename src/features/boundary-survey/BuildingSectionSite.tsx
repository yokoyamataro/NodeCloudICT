// 07 現地 の 状況。 3 つ の サブ テーブル + 写真。
//   (A) 申請敷地内 の 状況 (siteStatuses)
//   (B) 申請建物 の 状況 (概要) + 認定 (attestations)
//   (C) 申請建物 の 状況 (詳細) — 構造 / 床面積算定 (details)
//   (D) 写真 (photos)
//
// 写真 は 当面 ファイル 選択 → base64 で body に 直接 持つ (Phase 2 で Storage へ)。

import { useRef } from 'react'
import { Plus, Trash2, Image } from 'lucide-react'
import type {
  BuildingAttestationRow,
  BuildingDetailRow,
  BuildingPhoto,
  BuildingReportBody,
  BuildingSiteStatusRow,
  FloorAreaEntry,
} from '@/stores/buildingReportStore'
import { defaultDetailRow } from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

const FLOOR_LABELS: { key: keyof BuildingDetailRow['floorArea']; label: string; special?: boolean }[] = [
  { key: 'atrium',       label: '吹抜' },
  { key: 'bayWindow',    label: '出窓' },
  { key: 'stairs',       label: '階段室' },
  { key: 'piloti',       label: 'ピロティ' },
  { key: 'veranda',      label: 'ベランダ等' },
  { key: 'loft',         label: 'ロフト', special: true },
  { key: 'atticSpace',   label: '小屋裏', special: true },
  { key: 'underFloor',   label: '床下収納', special: true },
  { key: 'otherSpecial', label: '特殊階その他', special: true },
  { key: 'other',        label: 'その他' },
]

function emptyStatus(appNo: number): BuildingSiteStatusRow {
  return { appNo, unregisteredExists: null, registeredExists: null, kindStructureOwner: '', notes: '' }
}
function emptyAttest(appNo: number): BuildingAttestationRow {
  return {
    appNo,
    surveyStart: '', surveyEnd: '', mainSubType: '',
    annex: { usage: '', location: '', consent: '' },
    attestation: {
      fixation: null, airSeparation: null, usability: null, tradability: null,
      completion: null, notes: '',
    },
  }
}

function YesNoSel({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <select
      value={value === null ? '' : value ? 'y' : 'n'}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'y')}
      className="px-1 py-0.5 text-xs border rounded bg-white"
    >
      <option value="">—</option>
      <option value="y">有</option>
      <option value="n">無</option>
    </select>
  )
}

function FloorEntryEdit({ v, onChange }: { v: FloorAreaEntry; onChange: (p: Partial<FloorAreaEntry>) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <YesNoSel value={v.exists} onChange={(exists) => onChange({ exists })} />
      <select
        value={v.counted === null ? '' : v.counted ? '算' : '不'}
        onChange={(e) =>
          onChange({ counted: e.target.value === '' ? null : e.target.value === '算' })
        }
        className="px-1 py-0.5 text-xs border rounded bg-white"
      >
        <option value="">床面積—</option>
        <option value="算">算入</option>
        <option value="不">不算入</option>
      </select>
      <input
        type="text"
        value={v.note}
        onChange={(e) => onChange({ note: e.target.value })}
        placeholder="メモ (例: 高さ1.5m未満)"
        className="flex-1 min-w-[8rem] px-1 py-0.5 text-xs border rounded"
      />
    </div>
  )
}

export function BuildingSectionSite({ body, onChange }: Props) {
  // ---------------- siteStatuses ----------------
  const setStatuses = (next: BuildingSiteStatusRow[]) => onChange({ siteStatuses: next })
  const patchStatus = (idx: number, p: Partial<BuildingSiteStatusRow>) =>
    setStatuses(body.siteStatuses.map((r, i) => (i === idx ? { ...r, ...p } : r)))

  // ---------------- attestations ----------------
  const setAttests = (next: BuildingAttestationRow[]) => onChange({ attestations: next })
  const patchAttest = (idx: number, p: Partial<BuildingAttestationRow>) =>
    setAttests(body.attestations.map((r, i) => (i === idx ? { ...r, ...p } : r)))

  // ---------------- details ----------------
  const setDetails = (next: BuildingDetailRow[]) => onChange({ details: next })
  const patchDetail = (idx: number, p: Partial<BuildingDetailRow>) =>
    setDetails(body.details.map((r, i) => (i === idx ? { ...r, ...p } : r)))

  // ---------------- photos ----------------
  const setPhotos = (next: BuildingPhoto[]) => onChange({ photos: next })
  const patchPhoto = (id: string, p: Partial<BuildingPhoto>) =>
    setPhotos(body.photos.map((ph) => (ph.id === id ? { ...ph, ...p } : ph)))
  const fileRef = useRef<HTMLInputElement | null>(null)

  const addPhoto = () => fileRef.current?.click()
  const onPickFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0]
    ev.target.value = ''
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      setPhotos([
        ...body.photos,
        {
          id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          caption: '',
          dataUrl: url,
          takenOn: '',
          remark: '',
        },
      ])
    }
    reader.readAsDataURL(f)
  }

  return (
    <div className="p-3 space-y-4">
      {/* ---------- A. 申請敷地内 の 状況 ---------- */}
      <section className="border rounded">
        <header className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">A. 申請敷地内の状況</span>
          <button
            type="button"
            onClick={() => setStatuses([...body.siteStatuses, emptyStatus(body.siteStatuses.length + 1)])}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded hover:bg-white"
          >
            <Plus className="h-3 w-3" /> 行追加
          </button>
        </header>
        {body.siteStatuses.map((r, idx) => (
          <div key={idx} className="p-2 border-b last:border-b-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">申請番号</span>
              <input
                type="number" min="1" value={r.appNo}
                onChange={(e) => patchStatus(idx, { appNo: Math.max(1, Number(e.target.value) || 1) })}
                className="w-14 px-1 py-0.5 text-xs border rounded font-mono text-center"
              />
              <span className="text-xs text-slate-500 ml-2">未登記建物</span>
              <YesNoSel value={r.unregisteredExists} onChange={(v) => patchStatus(idx, { unregisteredExists: v })} />
              <span className="text-xs text-slate-500">既登記建物</span>
              <YesNoSel value={r.registeredExists} onChange={(v) => patchStatus(idx, { registeredExists: v })} />
              <button
                type="button"
                onClick={() => setStatuses(body.siteStatuses.filter((_, i) => i !== idx))}
                className="ml-auto p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <label className="block">
              <span className="block text-[11px] text-slate-500">種類・構造・所有者等</span>
              <input
                type="text" value={r.kindStructureOwner}
                onChange={(e) => patchStatus(idx, { kindStructureOwner: e.target.value })}
                className="w-full px-1.5 py-1 text-xs border rounded"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-slate-500">注意点・問題点等 (必要に応じて位置関係の図を添付)</span>
              <textarea
                rows={2} value={r.notes}
                onChange={(e) => patchStatus(idx, { notes: e.target.value })}
                className="w-full px-1.5 py-1 text-xs border rounded"
              />
            </label>
          </div>
        ))}
      </section>

      {/* ---------- B. 申請建物 の 状況 (概要) + 認定 ---------- */}
      <section className="border rounded">
        <header className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">B. 申請建物の状況（概要）+ 認定</span>
          <button
            type="button"
            onClick={() => setAttests([...body.attestations, emptyAttest(body.attestations.length + 1)])}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded hover:bg-white"
          >
            <Plus className="h-3 w-3" /> 行追加
          </button>
        </header>
        {body.attestations.map((r, idx) => (
          <div key={idx} className="p-2 border-b last:border-b-0 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">申請番号</span>
              <input
                type="number" min="1" value={r.appNo}
                onChange={(e) => patchAttest(idx, { appNo: Math.max(1, Number(e.target.value) || 1) })}
                className="w-14 px-1 py-0.5 text-xs border rounded font-mono text-center"
              />
              <span className="text-xs text-slate-500">調査期間</span>
              <input
                type="date" value={r.surveyStart}
                onChange={(e) => patchAttest(idx, { surveyStart: e.target.value })}
                className="px-1 py-0.5 text-xs border rounded"
              />
              <span>〜</span>
              <input
                type="date" value={r.surveyEnd}
                onChange={(e) => patchAttest(idx, { surveyEnd: e.target.value })}
                className="px-1 py-0.5 text-xs border rounded"
              />
              <button
                type="button"
                onClick={() => setAttests(body.attestations.filter((_, i) => i !== idx))}
                className="ml-auto p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <label className="block">
              <span className="block text-[11px] text-slate-500">主附の別及び符号</span>
              <input
                type="text" value={r.mainSubType}
                onChange={(e) => patchAttest(idx, { mainSubType: e.target.value })}
                className="w-full px-1.5 py-1 text-xs border rounded"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="block text-[11px] text-slate-500">附属建物: 利用状況</span>
                <input
                  type="text" value={r.annex.usage}
                  onChange={(e) => patchAttest(idx, { annex: { ...r.annex, usage: e.target.value } })}
                  className="w-full px-1.5 py-1 text-xs border rounded"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] text-slate-500">附属建物: 位置</span>
                <input
                  type="text" value={r.annex.location}
                  onChange={(e) => patchAttest(idx, { annex: { ...r.annex, location: e.target.value } })}
                  className="w-full px-1.5 py-1 text-xs border rounded"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] text-slate-500">附属建物: 意思確認</span>
                <input
                  type="text" value={r.annex.consent}
                  onChange={(e) => patchAttest(idx, { annex: { ...r.annex, consent: e.target.value } })}
                  className="w-full px-1.5 py-1 text-xs border rounded"
                />
              </label>
            </div>
            <div className="pt-1 border-t">
              <div className="text-[11px] text-slate-600 font-semibold mb-1">建物の認定</div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {([
                  ['fixation', '定着性'],
                  ['airSeparation', '外気分断性'],
                  ['usability', '用途性・人貨滞留性'],
                  ['tradability', '取引性'],
                ] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1 text-xs">
                    <span>{label}</span>
                    <YesNoSel
                      value={r.attestation[k]}
                      onChange={(v) => patchAttest(idx, { attestation: { ...r.attestation, [k]: v } })}
                    />
                  </label>
                ))}
                <label className="flex items-center gap-1 text-xs">
                  <span>完成度</span>
                  <select
                    value={r.attestation.completion ?? ''}
                    onChange={(e) =>
                      patchAttest(idx, {
                        attestation: {
                          ...r.attestation,
                          completion:
                            e.target.value === ''
                              ? null
                              : (e.target.value as 'completed' | 'in_progress'),
                        },
                      })
                    }
                    className="px-1 py-0.5 text-xs border rounded bg-white"
                  >
                    <option value="">—</option>
                    <option value="completed">完成</option>
                    <option value="in_progress">工事途中</option>
                  </select>
                </label>
              </div>
              <label className="block mt-1">
                <span className="block text-[11px] text-slate-500">注意点・問題点等</span>
                <textarea
                  rows={2} value={r.attestation.notes}
                  onChange={(e) =>
                    patchAttest(idx, { attestation: { ...r.attestation, notes: e.target.value } })
                  }
                  className="w-full px-1.5 py-1 text-xs border rounded"
                />
              </label>
            </div>
          </div>
        ))}
      </section>

      {/* ---------- C. 詳細 (構造 + 床面積算定) ---------- */}
      <section className="border rounded">
        <header className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">C. 申請建物の状況（詳細）</span>
          <button
            type="button"
            onClick={() =>
              setDetails([...body.details, defaultDetailRow(body.details.length + 1)])
            }
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded hover:bg-white"
          >
            <Plus className="h-3 w-3" /> 行追加
          </button>
        </header>
        {body.details.map((r, idx) => (
          <div key={idx} className="p-2 border-b last:border-b-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">申請番号</span>
              <input
                type="number" min="1" value={r.appNo}
                onChange={(e) => patchDetail(idx, { appNo: Math.max(1, Number(e.target.value) || 1) })}
                className="w-14 px-1 py-0.5 text-xs border rounded font-mono text-center"
              />
              <button
                type="button"
                onClick={() => setDetails(body.details.filter((_, i) => i !== idx))}
                className="ml-auto p-1 text-red-600 hover:bg-red-50 rounded"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['kind', '種類'],
                ['material', '構成材料'],
                ['roof', '屋根の種類'],
                ['floors', '階数'],
              ] as const).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="block text-[11px] text-slate-500">{label}</span>
                  <input
                    type="text" value={r.structure[k]}
                    onChange={(e) => patchDetail(idx, { structure: { ...r.structure, [k]: e.target.value } })}
                    className="w-full px-1.5 py-1 text-xs border rounded"
                  />
                </label>
              ))}
            </div>
            <div className="pt-1 border-t">
              <div className="text-[11px] text-slate-600 font-semibold mb-1">床面積の算定</div>
              <div className="space-y-1">
                {FLOOR_LABELS.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <span className="w-20 text-[11px] text-slate-600">
                      {f.special && <span className="text-slate-400 text-[10px] mr-0.5">[特殊階]</span>}
                      {f.label}
                    </span>
                    <div className="flex-1">
                      <FloorEntryEdit
                        v={r.floorArea[f.key]}
                        onChange={(p) =>
                          patchDetail(idx, {
                            floorArea: { ...r.floorArea, [f.key]: { ...r.floorArea[f.key], ...p } },
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ---------- D. 写真 ---------- */}
      <section className="border rounded">
        <header className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">D. 現地写真</span>
          <input
            ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={onPickFile}
          />
          <button
            type="button"
            onClick={addPhoto}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded hover:bg-white"
          >
            <Image className="h-3 w-3" /> 写真追加
          </button>
        </header>
        <div className="p-2 grid grid-cols-2 md:grid-cols-3 gap-2">
          {body.photos.length === 0 && (
            <div className="col-span-full text-xs text-slate-500">写真を追加してください (キャプション・撮影年月日・備考を各写真ごとに記録)。</div>
          )}
          {body.photos.map((ph) => (
            <div key={ph.id} className="border rounded p-1 space-y-1">
              <input
                type="text" value={ph.caption}
                onChange={(e) => patchPhoto(ph.id, { caption: e.target.value })}
                placeholder="例: 西から東に向かって撮影"
                className="w-full px-1 py-0.5 text-xs border rounded"
              />
              {ph.dataUrl && (
                <img src={ph.dataUrl} alt="" className="w-full h-32 object-cover rounded" />
              )}
              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-slate-500">撮影</span>
                <input
                  type="date" value={ph.takenOn}
                  onChange={(e) => patchPhoto(ph.id, { takenOn: e.target.value })}
                  className="flex-1 px-1 py-0.5 border rounded"
                />
                <button
                  type="button"
                  onClick={() => setPhotos(body.photos.filter((x) => x.id !== ph.id))}
                  className="p-0.5 text-red-600 hover:bg-red-50 rounded"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                type="text" value={ph.remark}
                onChange={(e) => patchPhoto(ph.id, { remark: e.target.value })}
                placeholder="備考"
                className="w-full px-1 py-0.5 text-xs border rounded"
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
