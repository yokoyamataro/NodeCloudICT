// 地番管理 の 右パネル (aside) 「地番情報」 タブ の 中身。
//
// 選ばれた 1 筆 の 属性 を inline で 編集 する。
// セクション:
//   共通:  所在 / 地番
//   登記:  地目 / 地積 / 所有者氏名 / 所有者住所
//   確定:  地目 / 地積 (立会・確定測量 後 の 変更 値)
//   メタ:  連番 / 区分 / 状態 / 不動産番号 (登記 CSV 由来、 read-only)
//   合筆:  合筆後地積 (= 残地 の 面積、 合筆 操作 で 自動 設定、 値 が あれば 表示)
//   備考:  自由 入力
// blur で parcelStore.upsertParcel を 呼んで 保存。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import type { ParcelEditableFields } from '@/stores/parcelStore'
import type { Parcel } from '@/types/database'
import { LAND_CATEGORIES } from '@/lib/landCategory'
import { useLandownerStore } from '@/stores/landownerStore'
import { useLandHistoryStore, formatLandHistoryLine, EMPTY_LAND_HISTORY } from '@/stores/landHistoryStore'
import { parseRegistryPdfViaAI } from '@/lib/registryPdf'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { useFarmStore } from '@/stores/farmStore'
import { REGISTRY_PDF_CATEGORY } from './RegistryPdfImportModal'

interface Props {
  workAreaId: string
  parcel: Parcel | null
  onPatch: (patch: Partial<ParcelEditableFields>) => void
  readOnly?: boolean
}

const numStr = (n: number | null | undefined): string =>
  n == null ? '' : String(n)
const parseNum = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const REGISTRATION_KIND_LABELS: Record<string, string> = {
  registered: '登記済 (CSV)',
  provisional: '仮',
  confirmed: '確定',
}

export function ParcelDetailsSection({ workAreaId: _workAreaId, parcel, onPatch, readOnly = false }: Props) {
  // 地権者 を 地番 単位 で 引く。 既に 工区 単位 で fetch 済み の 想定 (親 側 で 読み込み)
  const landowners = useLandownerStore((s) => s.landowners)
  const landownersByParcelId = useLandownerStore((s) => s.landownersByParcelId)
  const setParcelAssignment = useLandownerStore((s) => s.setParcelAssignment)
  const linkedLandownerIds = useMemo(() => {
    if (!parcel) return [] as string[]
    return landownersByParcelId.get(parcel.id) ?? []
  }, [parcel, landownersByParcelId])
  const landownerById = useMemo(
    () => new Map(landowners.map((lo) => [lo.id, lo])),
    [landowners],
  )
  const linkedLandowners = useMemo(
    () => linkedLandownerIds.map((id) => landownerById.get(id)).filter((lo): lo is NonNullable<typeof lo> => !!lo),
    [linkedLandownerIds, landownerById],
  )
  const unlinkedLandowners = useMemo(() => {
    const linkedSet = new Set(linkedLandownerIds)
    return landowners.filter((lo) => !linkedSet.has(lo.id))
  }, [landowners, linkedLandownerIds])
  const [addLandownerId, setAddLandownerId] = useState('')
  const handleAddLandowner = () => {
    if (!parcel || !addLandownerId || readOnly) return
    void setParcelAssignment(parcel.id, [...linkedLandownerIds, addLandownerId])
    setAddLandownerId('')
  }
  const handleRemoveLandowner = (id: string) => {
    if (!parcel || readOnly) return
    void setParcelAssignment(parcel.id, linkedLandownerIds.filter((x) => x !== id))
  }

  // 土地の沿革 (parcel_display_histories)。 `?? []` だと 毎回 新しい 空配列 に
  // なって Zustand の 参照 比較 を 壊し 無限 再レンダ する ので 定数 を 使う。
  const landHistoryRows = useLandHistoryStore((s) =>
    parcel ? s.byParcelId.get(parcel.id) ?? EMPTY_LAND_HISTORY : EMPTY_LAND_HISTORY,
  )

  // 登記 PDF の 1 件 アップロード + AI 解析。 全部事項 の 想定 で kind='full'。
  // ParcelDetailsSection は 1 筆 だけ 相手 に する の で、 bulk 画面 (RegistryPdfImportModal)
  // より 単純。 解析後 は 現在 の 地番 の parcel を 直接 上書き。
  const uploadFile = useAttachmentStore((s) => s.uploadFile)
  const projectId = useFarmStore((s) => s.currentFarm?.project_id ?? null)
  const pdfInputRef = useRef<HTMLInputElement | null>(null)
  const [registryUploading, setRegistryUploading] = useState(false)
  const [registryMessage, setRegistryMessage] = useState<string | null>(null)
  const handleRegistryPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !parcel) return
    setRegistryUploading(true)
    setRegistryMessage(null)
    try {
      const parsed = await parseRegistryPdfViaAI(file, 'full', {
        location: parcel.location,
        parcel_number: parcel.parcel_number,
      })
      const patch: Partial<ParcelEditableFields> = {}
      if (parsed.location && !parcel.location) patch.location = parsed.location
      if (parsed.parcelNumber && !parcel.parcel_number) patch.parcel_number = parsed.parcelNumber
      if (parsed.landCategory) patch.registered_land_category = parsed.landCategory
      if (parsed.areaSqm != null) patch.registered_area_sqm = parsed.areaSqm
      if (parsed.owners.length > 0) {
        patch.registered_owner_name = parsed.owners[0].fullName
        patch.registered_owner_address = parsed.owners[0].address
      }
      if (Object.keys(patch).length > 0) {
        commit(patch)
        // ローカル state も 即 反映 (親 からの 再 sync を 待たず に 画面 を 新しく)
        if (patch.registered_land_category !== undefined) setRegCategory(patch.registered_land_category ?? '')
        if (patch.registered_area_sqm !== undefined) setRegArea(numStr(patch.registered_area_sqm))
        if (patch.registered_owner_name !== undefined) setOwnerName(patch.registered_owner_name ?? '')
        if (patch.registered_owner_address !== undefined) setOwnerAddr(patch.registered_owner_address ?? '')
        if (patch.location !== undefined) setLocation(patch.location ?? '')
        if (patch.parcel_number !== undefined) setParcelNumber(patch.parcel_number ?? '')
      }
      // 原本 PDF を attachments に 保管 (後 で ダウンロード 可能)
      if (projectId) {
        await uploadFile({
          projectId,
          entityType: 'work_area',
          entityId: _workAreaId,
          file,
          category: REGISTRY_PDF_CATEGORY,
          fileName: file.name,
          caption: file.name,
        })
      }
      const extras = parsed.warnings.length > 0 ? ` / 警告: ${parsed.warnings.join(', ')}` : ''
      setRegistryMessage(
        `取込 完了 (信頼度 ${(parsed.confidence * 100).toFixed(0)}%)${extras}`,
      )
    } catch (err) {
      setRegistryMessage(
        `取込 失敗: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setRegistryUploading(false)
    }
  }
  const [location, setLocation] = useState(parcel?.location ?? '')
  const [parcelNumber, setParcelNumber] = useState(parcel?.parcel_number ?? '')
  const [regCategory, setRegCategory] = useState(parcel?.registered_land_category ?? '')
  const [regArea, setRegArea] = useState<string>(numStr(parcel?.registered_area_sqm))
  const [updCategory, setUpdCategory] = useState(parcel?.updated_land_category ?? '')
  const [updArea, setUpdArea] = useState<string>(numStr(parcel?.updated_area_sqm))
  const [ownerName, setOwnerName] = useState(parcel?.registered_owner_name ?? '')
  const [ownerAddr, setOwnerAddr] = useState(parcel?.registered_owner_address ?? '')
  const [notes, setNotes] = useState(parcel?.notes ?? '')

  // parcel が 差し替わったら state を 再同期
  useEffect(() => {
    setLocation(parcel?.location ?? '')
    setParcelNumber(parcel?.parcel_number ?? '')
    setRegCategory(parcel?.registered_land_category ?? '')
    setRegArea(numStr(parcel?.registered_area_sqm))
    setUpdCategory(parcel?.updated_land_category ?? '')
    setUpdArea(numStr(parcel?.updated_area_sqm))
    setOwnerName(parcel?.registered_owner_name ?? '')
    setOwnerAddr(parcel?.registered_owner_address ?? '')
    setNotes(parcel?.notes ?? '')
  }, [
    parcel?.id,
    parcel?.location,
    parcel?.parcel_number,
    parcel?.registered_land_category,
    parcel?.registered_area_sqm,
    parcel?.updated_land_category,
    parcel?.updated_area_sqm,
    parcel?.registered_owner_name,
    parcel?.registered_owner_address,
    parcel?.notes,
  ])

  const commit = (patch: Partial<ParcelEditableFields>) => {
    if (readOnly) return
    onPatch(patch)
  }

  const inputCls =
    'px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100'
  const numInputCls =
    'flex-1 px-1.5 py-0.5 border rounded text-xs font-mono bg-white disabled:bg-slate-100'

  // CSV メタ or 分筆 / 合筆 情報 が ある か (= セクション を 出す か の 判定)
  const hasMeta =
    parcel?.registry_seq != null ||
    (parcel?.registration_kind && parcel.registration_kind !== 'provisional') ||
    !!parcel?.registry_status ||
    !!parcel?.real_estate_number
  const hasMergedArea = parcel?.merged_area_sqm != null

  return (
    <div className="px-3 py-2 bg-slate-50 space-y-2">
      {/* 共通: 所在 / 地番 */}
      <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
        <label className="text-slate-500">所在</label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onBlur={() => commit({ location: location.trim() || null })}
          disabled={readOnly}
          className={inputCls}
          placeholder="所在"
        />
        <label className="text-slate-500">地番</label>
        <input
          type="text"
          value={parcelNumber}
          onChange={(e) => setParcelNumber(e.target.value)}
          onBlur={() => commit({ parcel_number: parcelNumber.trim() || null })}
          disabled={readOnly}
          className={inputCls}
          placeholder="例: 10-6"
        />
      </div>

      {/* 登記 PDF を 1 件 アップロード → AI で 解析 → 下 の 登記 セクション を 自動 入力 */}
      {!readOnly && parcel && (
        <div className="flex items-center gap-2">
          <input
            ref={pdfInputRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleRegistryPdf}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => pdfInputRef.current?.click()}
            disabled={registryUploading}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
            title="登記情報 PDF を 1 件 アップロード して AI で 地目 / 地積 / 所有者 を 読み取る"
          >
            {registryUploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                解析中…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                登記PDF取込 (AI)
              </>
            )}
          </button>
          {registryMessage && (
            <span
              className={`text-[11px] truncate ${
                registryMessage.startsWith('取込 完了')
                  ? 'text-emerald-700'
                  : 'text-red-600'
              }`}
              title={registryMessage}
            >
              {registryMessage}
            </span>
          )}
        </div>
      )}

      {/* 登記 (登記簿・登記CSV の 値) */}
      <fieldset className="border border-slate-300 rounded p-2 pt-1 bg-white">
        <legend className="px-1 text-[10px] text-slate-500 font-medium uppercase tracking-wide">
          登記
        </legend>
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
          <label className="text-slate-500">地目</label>
          <select
            value={regCategory}
            onChange={(e) => {
              setRegCategory(e.target.value)
              commit({ registered_land_category: e.target.value || null })
            }}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(未設定)</option>
            {LAND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="text-slate-500">地積</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={regArea}
              onChange={(e) => setRegArea(e.target.value)}
              onBlur={() => commit({ registered_area_sqm: parseNum(regArea) })}
              disabled={readOnly}
              className={numInputCls}
              placeholder="m²"
            />
            <span className="text-slate-400 text-[10px]">m²</span>
          </div>
          <label className="text-slate-500">所有者</label>
          <input
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            onBlur={() => commit({ registered_owner_name: ownerName.trim() || null })}
            disabled={readOnly}
            className={inputCls}
            placeholder="登記所有者氏名"
          />
          <label className="text-slate-500">所有者住所</label>
          <input
            type="text"
            value={ownerAddr}
            onChange={(e) => setOwnerAddr(e.target.value)}
            onBlur={() => commit({ registered_owner_address: ownerAddr.trim() || null })}
            disabled={readOnly}
            className={inputCls}
            placeholder="登記所有者住所"
          />
        </div>
      </fieldset>

      {/* 確定 (立会・確定測量 後 の 変更 値) */}
      <fieldset className="border border-emerald-300 rounded p-2 pt-1 bg-emerald-50/40">
        <legend className="px-1 text-[10px] text-emerald-700 font-medium uppercase tracking-wide">
          確定
        </legend>
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
          <label className="text-slate-500">地目</label>
          <select
            value={updCategory}
            onChange={(e) => {
              setUpdCategory(e.target.value)
              commit({ updated_land_category: e.target.value || null })
            }}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(未設定)</option>
            {LAND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="text-slate-500">地積</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={updArea}
              onChange={(e) => setUpdArea(e.target.value)}
              onBlur={() => commit({ updated_area_sqm: parseNum(updArea) })}
              disabled={readOnly}
              className={numInputCls}
              placeholder="m²"
            />
            <span className="text-slate-400 text-[10px]">m²</span>
          </div>
        </div>
      </fieldset>

      {/* 登記 CSV 由来 の メタ 情報。 read-only (CSV 取込 で 自動 設定) */}
      {hasMeta && (
        <fieldset className="border border-slate-300 rounded p-2 pt-1 bg-slate-100/60">
          <legend className="px-1 text-[10px] text-slate-500 font-medium uppercase tracking-wide">
            登記 CSV メタ
          </legend>
          <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-xs items-center">
            {parcel?.registry_seq != null && (
              <>
                <label className="text-slate-500">連番</label>
                <span className="font-mono">{parcel.registry_seq}</span>
              </>
            )}
            {parcel?.registration_kind && (
              <>
                <label className="text-slate-500">区分</label>
                <span>
                  {REGISTRATION_KIND_LABELS[parcel.registration_kind] ?? parcel.registration_kind}
                </span>
              </>
            )}
            {parcel?.registry_kind && (
              <>
                <label className="text-slate-500">物件種別</label>
                <span>{parcel.registry_kind}</span>
              </>
            )}
            {parcel?.registry_status && (
              <>
                <label className="text-slate-500">状態</label>
                <span>{parcel.registry_status}</span>
              </>
            )}
            {parcel?.real_estate_number && (
              <>
                <label className="text-slate-500">不動産番号</label>
                <span className="font-mono text-[11px] break-all">{parcel.real_estate_number}</span>
              </>
            )}
          </div>
        </fieldset>
      )}

      {/* 合筆後地積 (= 残地 の 新 地積、 合筆 操作 で 自動 設定) */}
      {hasMergedArea && (
        <fieldset className="border border-amber-300 rounded p-2 pt-1 bg-amber-50/60">
          <legend className="px-1 text-[10px] text-amber-700 font-medium uppercase tracking-wide">
            合筆
          </legend>
          <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-xs items-center">
            <label className="text-slate-500">合筆後地積</label>
            <div className="flex items-center gap-1">
              <span className="font-mono">{Number(parcel!.merged_area_sqm).toFixed(2)}</span>
              <span className="text-slate-400 text-[10px]">m²</span>
            </div>
          </div>
        </fieldset>
      )}

      {/* 地権者 (parcel_landowners 由来)。 ここ で も 追加 / 削除 できる。
          新規 の 地権者 自体 の 作成 は 地権者管理 ページ で */}
      <fieldset className="border border-blue-300 rounded p-2 pt-1 bg-blue-50/40">
        <legend className="px-1 text-[10px] text-blue-700 font-medium uppercase tracking-wide">
          地権者 ({linkedLandowners.length})
        </legend>
        {linkedLandowners.length > 0 && (
          <ul className="space-y-1 text-xs">
            {linkedLandowners.map((lo) => (
              <li key={lo.id} className="bg-white border border-slate-200 rounded px-2 py-1 flex items-start gap-1">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate" title={lo.full_name}>
                    {lo.full_name}
                  </div>
                  {lo.address && (
                    <div className="text-[10px] text-slate-500 truncate" title={lo.address}>
                      {lo.postal_code ? `〒${lo.postal_code} ` : ''}
                      {lo.address}
                    </div>
                  )}
                  {lo.phone && (
                    <div className="text-[10px] text-slate-500 font-mono">{lo.phone}</div>
                  )}
                  {lo.agent_name && (
                    <div className="text-[10px] text-slate-500">
                      代理人: {lo.agent_name}
                      {lo.agent_relation ? ` (${lo.agent_relation})` : ''}
                    </div>
                  )}
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => handleRemoveLandowner(lo.id)}
                    title="紐付け 解除"
                    className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && parcel && (
          <div className="mt-2 flex items-center gap-1">
            <select
              value={addLandownerId}
              onChange={(e) => setAddLandownerId(e.target.value)}
              className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-xs bg-white"
              disabled={unlinkedLandowners.length === 0}
            >
              <option value="">
                {unlinkedLandowners.length === 0
                  ? landowners.length === 0
                    ? '地権者 未登録'
                    : '追加 可能 な 地権者 無し'
                  : '＋ 地権者 を 選択'}
              </option>
              {unlinkedLandowners.map((lo) => (
                <option key={lo.id} value={lo.id}>
                  {lo.full_name}
                  {lo.address ? ` / ${lo.address}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAddLandowner}
              disabled={!addLandownerId}
              className="shrink-0 px-2 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              追加
            </button>
          </div>
        )}
      </fieldset>

      {/* 土地の沿革 (parcel_display_histories 由来)。 編集 は CSV 取込 由来 のみ の 想定 で read-only */}
      <fieldset className="border border-slate-300 rounded p-2 pt-1 bg-white">
        <legend className="px-1 text-[10px] text-slate-500 font-medium uppercase tracking-wide">
          土地の沿革 ({landHistoryRows.length})
        </legend>
        {landHistoryRows.length === 0 ? (
          <div className="text-[11px] text-slate-400 py-0.5">
            沿革 無し (登記 CSV を 取り込む と 自動 設定)
          </div>
        ) : (
          <ol className="space-y-1 text-xs">
            {landHistoryRows.map((r) => {
              const line = formatLandHistoryLine(r)
              return (
                <li key={r.id} className="border-l-2 border-slate-300 pl-2">
                  <div className="text-[11px] text-slate-700 leading-snug">
                    {line || '—'}
                  </div>
                  {(r.parcel_number || r.land_category || r.area_text) && (
                    <div className="text-[10px] text-slate-400 font-mono">
                      {r.parcel_number ?? ''}
                      {r.land_category ? ` / ${r.land_category}` : ''}
                      {r.area_text ? ` / ${r.area_text} m²` : ''}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </fieldset>

      {/* 備考 */}
      <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-start">
        <label className="text-slate-500 pt-1">備考</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => commit({ notes: notes.trim() || null })}
          disabled={readOnly}
          rows={2}
          className="px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100 resize-y"
          placeholder="備考"
        />
      </div>
    </div>
  )
}
