// 登記情報 PDF 取込モーダル。
// 複数 PDF を選択 → クライアント側で解析 → 抽出した
// 所在 / 地番 / 地目 / 地積 / 所有者氏名・住所 を、
// 既存の地番 (parcels) に当て込んでまとめて upsert する。
//
// マッチングは「ハイブリッド」: 所在 + 地番 で自動候補を出すが、
// ユーザはセレクタで任意の地番に差し替えられる。

import { useMemo, useState } from 'react'
import { Loader2, Upload, X, AlertTriangle, Check } from 'lucide-react'
import {
  parseRegistryPdf,
  normalizeParcelNumber,
  type ParsedRegistry,
} from '@/lib/registryPdf'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'

interface Props {
  /** 当該工区の地番一覧（境界測量 work_areas） */
  areas: WorkAreaRow[]
  onClose: () => void
}

interface ImportRow {
  id: string
  file: File
  status: 'parsing' | 'ready' | 'error'
  parsed: ParsedRegistry | null
  error: string | null
  /** 当てる先の area.id（自動候補 or ユーザ選択） */
  matchedAreaId: string | null
  apply: boolean
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s　]+/g, '').trim()
}

export function RegistryPdfImportModal({ areas, onClose }: Props) {
  const parcelMap = useParcelStore((s) => s.byWorkAreaId)
  const upsertParcel = useParcelStore((s) => s.upsertParcel)

  const [rows, setRows] = useState<ImportRow[]>([])
  const [applying, setApplying] = useState(false)
  const [applyDone, setApplyDone] = useState<{ ok: number; skipped: number } | null>(null)

  // area.id → 候補ラベル用の正規化キー
  const areaIndex = useMemo(() => {
    return areas.map((a) => {
      const p = parcelMap.get(a.id)
      const num = p?.parcel_number || a.zoneNumber || a.name || ''
      const loc = p?.location ?? ''
      return {
        areaId: a.id,
        normLoc: normalize(loc),
        normNum: normalizeParcelNumber(num),
        label: `${loc || '(所在なし)'} ${num || '(地番なし)'}`,
        location: loc,
        parcelNumber: num,
        parcel: p,
      }
    })
  }, [areas, parcelMap])

  // 自動マッチ
  const autoMatch = (parsed: ParsedRegistry): string | null => {
    const targetLoc = normalize(parsed.location)
    const targetNum = parsed.parcelNumber ? normalizeParcelNumber(parsed.parcelNumber) : ''
    if (!targetNum) return null
    // 所在 + 地番 完全一致 → 唯一の候補
    const both = areaIndex.filter(
      (a) => a.normLoc === targetLoc && a.normNum === targetNum,
    )
    if (both.length === 1) return both[0].areaId
    // 地番一致のみ
    const numOnly = areaIndex.filter((a) => a.normNum === targetNum)
    if (numOnly.length === 1) return numOnly[0].areaId
    return null
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setApplyDone(null)
    const newRows: ImportRow[] = []
    for (const f of Array.from(files)) {
      newRows.push({
        id: `${f.name}-${f.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        status: 'parsing',
        parsed: null,
        error: null,
        matchedAreaId: null,
        apply: true,
      })
    }
    setRows((prev) => [...prev, ...newRows])

    // 1 件ずつ並列で解析（重い PDF が来ても他がブロックされないように）
    for (const row of newRows) {
      try {
        const parsed = await parseRegistryPdf(row.file)
        const matched = autoMatch(parsed)
        setRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? { ...r, status: 'ready', parsed, matchedAreaId: matched }
              : r,
          ),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : '解析失敗'
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, status: 'error', error: msg } : r)),
        )
      }
    }
  }

  const handleApply = async () => {
    const toApply = rows.filter((r) => r.apply && r.parsed && r.matchedAreaId)
    if (toApply.length === 0) return
    setApplying(true)
    let ok = 0
    let skipped = 0
    try {
      for (const row of toApply) {
        const parsed = row.parsed!
        const areaId = row.matchedAreaId!
        const existing = parcelMap.get(areaId)
        const patch: Record<string, string | number | null> = {}
        // 所在: 既存が空のときだけ PDF から埋める
        if (!existing?.location && parsed.location) {
          patch.location = parsed.location
        }
        // 地番: 既存が空 or 異なる場合に上書き（PDF を真実とみなす）
        if (parsed.parcelNumber) {
          patch.parcel_number = parsed.parcelNumber
        }
        if (parsed.landCategory) {
          patch.registered_land_category = parsed.landCategory
        }
        if (parsed.areaSqm != null) {
          patch.registered_area_sqm = parsed.areaSqm
        }
        if (parsed.owners.length > 0) {
          const o = parsed.owners[0]
          patch.registered_owner_name = o.fullName
          patch.registered_owner_address = o.address
        }
        if (Object.keys(patch).length === 0) {
          skipped++
          continue
        }
        const saved = await upsertParcel(areaId, patch)
        if (saved) ok++
        else skipped++
      }
      setApplyDone({ ok, skipped })
    } finally {
      setApplying(false)
    }
  }

  const renderDiff = (
    label: string,
    current: string | number | null | undefined,
    next: string | number | null | undefined,
  ) => {
    const cur = current === null || current === undefined || current === '' ? '—' : String(current)
    const nxt = next === null || next === undefined || next === '' ? '—' : String(next)
    const changed = cur !== nxt && nxt !== '—'
    return (
      <div className="flex items-baseline gap-1 text-[11px]">
        <span className="text-slate-500 w-20 shrink-0">{label}:</span>
        <span className={`truncate ${changed ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{cur}</span>
        {changed && <span className="text-slate-400">→</span>}
        {changed && <span className="text-emerald-700 font-medium truncate">{nxt}</span>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Upload className="h-4 w-4 text-blue-600" />
          <h3 className="flex-1 text-base font-semibold">登記情報 PDF 取込</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ヘッダー: ファイル選択 */}
        <div className="px-4 py-3 border-b bg-slate-50">
          <label className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded cursor-pointer hover:bg-blue-700">
            <Upload className="h-3.5 w-3.5" />
            PDF を追加
            <input
              type="file"
              multiple
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <span className="ml-3 text-xs text-slate-500">
            複数選択可。所在 + 地番で自動マッチします（後から変更可）。
          </span>
        </div>

        {/* 行リスト */}
        <div className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              PDF を追加してください
            </div>
          ) : (
            <div className="divide-y">
              {rows.map((row) => (
                <ImportRowView
                  key={row.id}
                  row={row}
                  areas={areaIndex}
                  parcelMap={parcelMap}
                  onChangeArea={(areaId) =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id ? { ...r, matchedAreaId: areaId } : r,
                      ),
                    )
                  }
                  onToggleApply={() =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id ? { ...r, apply: !r.apply } : r,
                      ),
                    )
                  }
                  onRemove={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  renderDiff={renderDiff}
                />
              ))}
            </div>
          )}
        </div>

        {/* 結果 */}
        {applyDone && (
          <div className="px-4 py-2 bg-emerald-50 border-t text-sm text-emerald-800">
            適用完了: {applyDone.ok} 件 / スキップ: {applyDone.skipped} 件
          </div>
        )}

        {/* フッター: 適用 */}
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            閉じる
          </button>
          <button
            onClick={handleApply}
            disabled={applying || rows.filter((r) => r.apply && r.matchedAreaId).length === 0}
            className="flex items-center gap-1 px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {rows.filter((r) => r.apply && r.matchedAreaId).length} 件を反映
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportRowView({
  row,
  areas,
  parcelMap,
  onChangeArea,
  onToggleApply,
  onRemove,
  renderDiff,
}: {
  row: ImportRow
  areas: Array<{
    areaId: string
    normLoc: string
    normNum: string
    label: string
    location: string
    parcelNumber: string
    parcel: ReturnType<typeof useParcelStore.getState>['byWorkAreaId'] extends Map<string, infer P> ? P | undefined : never
  }>
  parcelMap: ReturnType<typeof useParcelStore.getState>['byWorkAreaId']
  onChangeArea: (areaId: string | null) => void
  onToggleApply: () => void
  onRemove: () => void
  renderDiff: (
    label: string,
    current: string | number | null | undefined,
    next: string | number | null | undefined,
  ) => React.ReactNode
}) {
  const parsed = row.parsed
  const existing = row.matchedAreaId ? parcelMap.get(row.matchedAreaId) : null
  const matched = row.matchedAreaId ? areas.find((a) => a.areaId === row.matchedAreaId) : null

  return (
    <div className="p-3">
      {/* 行ヘッダ */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          checked={row.apply}
          onChange={onToggleApply}
          disabled={row.status !== 'ready' || !row.matchedAreaId}
          className="h-4 w-4"
        />
        <div className="flex-1 truncate text-sm font-medium" title={row.file.name}>
          {row.file.name}
        </div>
        {row.status === 'parsing' && (
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        )}
        {row.status === 'error' && (
          <AlertTriangle className="h-4 w-4 text-red-500" />
        )}
        <button
          onClick={onRemove}
          className="text-xs text-slate-400 hover:text-red-600"
        >
          削除
        </button>
      </div>

      {row.status === 'error' && (
        <div className="px-2 py-1 text-xs text-red-700 bg-red-50 rounded border border-red-200">
          {row.error || '解析に失敗しました'}
        </div>
      )}

      {parsed && (
        <div className="grid grid-cols-2 gap-3">
          {/* 左: PDF からの抽出 */}
          <div className="text-xs space-y-0.5">
            <div className="text-slate-500 mb-1 font-medium">PDF から抽出</div>
            <div>所在: <span className="text-slate-800">{parsed.location ?? '—'}</span></div>
            <div>地番: <span className="text-slate-800">{parsed.parcelNumber ?? '—'}</span></div>
            <div>地目: <span className="text-slate-800">{parsed.landCategory ?? '—'}</span></div>
            <div>地積: <span className="text-slate-800">{parsed.areaSqm != null ? `${parsed.areaSqm.toFixed(2)} ㎡` : '—'}</span></div>
            <div>所有者:{' '}
              {parsed.owners.length === 0 ? (
                <span className="text-slate-400">—</span>
              ) : (
                <span className="text-slate-800">
                  {parsed.owners.map((o) => `${o.fullName} (${o.address})`).join('、')}
                </span>
              )}
            </div>
            {parsed.warnings.length > 0 && (
              <div className="text-amber-700 text-[10px] mt-1">
                ⚠ {parsed.warnings.join(' / ')}
              </div>
            )}
          </div>

          {/* 右: 当て先選択 + 差分 */}
          <div className="text-xs space-y-1">
            <div className="text-slate-500 mb-1 font-medium">当て先地番</div>
            <select
              value={row.matchedAreaId ?? ''}
              onChange={(e) => onChangeArea(e.target.value || null)}
              className="w-full px-2 py-1 text-xs border rounded bg-white"
            >
              <option value="">（地番を選択）</option>
              {areas.map((a) => (
                <option key={a.areaId} value={a.areaId}>
                  {a.label}
                </option>
              ))}
            </select>
            {matched && existing && (
              <div className="space-y-0.5 mt-1 border-t pt-1">
                {renderDiff('所在', existing.location, existing.location || parsed.location)}
                {renderDiff('地番', existing.parcel_number, parsed.parcelNumber)}
                {renderDiff('地目', existing.registered_land_category, parsed.landCategory)}
                {renderDiff('地積(㎡)', existing.registered_area_sqm, parsed.areaSqm)}
                {renderDiff('所有者氏名', existing.registered_owner_name, parsed.owners[0]?.fullName)}
                {renderDiff('所有者住所', existing.registered_owner_address, parsed.owners[0]?.address)}
              </div>
            )}
            {matched && !existing && (
              <div className="text-[11px] text-slate-500">
                （まだ parcels 行が無いため、新規作成されます）
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
