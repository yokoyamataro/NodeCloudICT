// 法務局備付地図作成作業 ページ。
//
// CSV 取込 → registry_* テーブル (project 単位) に 保存 まで 実装。
// project_owners / property_owner_shares の 名寄せ は 未実装 (次段階)。
// 行 クリック で 右側 に 所在履歴 / 表示履歴 / 所有権 / 甲区 / 乙区 を 詳細表示。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, Loader2, Trash2, Upload, X } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  latestDisplay,
  ownerSummary,
  parseRegistryCsv,
  readRegistryCsvFile,
  type RegistryRecord,
} from '@/lib/registryCsv'
import {
  deleteProjectRegistry,
  loadRegistryFromDb,
  projectHasRegistryData,
  saveRegistryCsv,
  updatePropertyFarm,
  type SaveProgress,
} from '@/lib/registryCsvSave'

// 集約 立会 の 表示。 null → '—'、'MIXED' → '混在'、それ以外 は 生値。
function formatVisitAt(v: string | 'MIXED' | null): string {
  if (v == null) return '—'
  if (v === 'MIXED') return '混在'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function formatVisitStatus(v: string | 'MIXED' | null): string {
  if (v == null || v === '') return '—'
  if (v === 'MIXED') return '混在'
  return v
}

export function RegistryMapWorkPage() {
  const { currentFarm, farms } = useFarmStore()
  const projectId = currentFarm?.project_id ?? null
  // 同 project の 工区 のみ 選択候補
  const projectFarms = useMemo(
    () => farms.filter((f) => f.project_id === projectId),
    [farms, projectId],
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'load' | 'import' | 'delete' | null>(null)
  const [records, setRecords] = useState<RegistryRecord[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [progress, setProgress] = useState<SaveProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return records
    return records.filter((r) => {
      const p = r.property
      if (p?.parcelNumber.includes(q)) return true
      if (p?.location.includes(q)) return true
      if (p?.realEstateNumber.includes(q)) return true
      if (r.ownerships.some((o) => o.ownerName.includes(q))) return true
      return false
    })
  }, [records, query])

  const selected =
    selectedSeq != null ? records.find((r) => r.seq === selectedSeq) ?? null : null

  // プロジェクト 切替時 に DB から 既存 の 登記 データ を 読み直す。
  const reloadFromDb = useCallback(async () => {
    if (!projectId) return
    setBusy('load')
    setError(null)
    setProgress({ phase: '物件を取得中', done: 0, total: 0 })
    try {
      const rows = await loadRegistryFromDb(projectId, (p) => setProgress(p))
      setRecords(rows)
      setSelectedSeq(null)
      setSource(rows.length > 0 ? '(DB 保存済み)' : null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'DB からの読込に失敗しました')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }, [projectId])

  useEffect(() => {
    void reloadFromDb()
  }, [reloadFromDb])

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !projectId) return

    setBusy('import')
    setError(null)
    setMessage(null)
    setProgress({ phase: 'CSV を解析中', done: 0, total: 0 })
    try {
      // 1) 既存 データ の 有無 確認
      const { hasAny, count } = await projectHasRegistryData(projectId)
      if (hasAny) {
        // 現段階 は 上書き 比較 UI 未実装。全消去 → 再取込 で 進める。
        const ok = confirm(
          `このプロジェクトには 既に ${count.toLocaleString()} 件 の 登記データ が あります。\n` +
            `全て 削除 して 今回 の CSV で 置き換えますか？\n\n` +
            `(比較 して 選択 する UI は 別段階 で 実装 予定 です)`,
        )
        if (!ok) {
          setBusy(null)
          setProgress(null)
          return
        }
        setProgress({ phase: '既存データを削除中', done: 0, total: 0 })
        await deleteProjectRegistry(projectId)
      }

      // 2) CSV を パース
      setProgress({ phase: 'CSV を解析中', done: 0, total: 0 })
      const text = await readRegistryCsvFile(file)
      const parsed = parseRegistryCsv(text)

      // 3) 6 テーブル を 保存
      const { inserted } = await saveRegistryCsv(
        projectId,
        parsed.records,
        (p) => setProgress(p),
      )

      // 4) DB から 読み直す (ID 付き)
      setProgress({ phase: '物件を取得中', done: 0, total: 0 })
      const reloaded = await loadRegistryFromDb(projectId)
      setRecords(reloaded)
      setSource(file.name)
      setSelectedSeq(null)
      setMessage(
        `${inserted.toLocaleString()} 件 を 保存しました ` +
          `(地権者リスト への 反映 は 「地権者リスト > 物件一覧 から 読込」 から)`,
      )
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'CSV 取込に失敗しました')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const handleAssignFarm = async (
    propertyId: string,
    farmId: string | null,
  ) => {
    try {
      await updatePropertyFarm(propertyId, farmId)
      const newFarmName = farmId
        ? projectFarms.find((f) => f.id === farmId)?.name ?? null
        : null
      setRecords((prev) =>
        prev.map((r) =>
          r.extras?.id === propertyId
            ? {
                ...r,
                extras: {
                  ...r.extras,
                  farmId,
                  farmName: newFarmName,
                },
              }
            : r,
        ),
      )
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : '工区の割当に失敗しました')
    }
  }

  const handleDeleteAll = async () => {
    if (!projectId) return
    const ok = confirm(
      `このプロジェクト の 登記データ を 全て 削除 します。\nよろしいですか？`,
    )
    if (!ok) return
    setBusy('delete')
    setError(null)
    setMessage(null)
    try {
      await deleteProjectRegistry(projectId)
      setRecords([])
      setSelectedSeq(null)
      setSource(null)
      setMessage('登記データを削除しました')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setBusy(null)
    }
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <div className="text-sm font-semibold text-slate-700">法務局備付地図作成作業</div>
        <div className="flex-1" />
        <input
          type="search"
          placeholder="地番 / 所在 / 所有者で絞込"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={records.length === 0}
          className="w-56 rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="flex items-center gap-1 rounded border bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
        >
          {busy === 'import' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          登記CSV読込
        </button>
        <button
          type="button"
          onClick={handleDeleteAll}
          disabled={busy !== null || records.length === 0}
          title="このプロジェクトの登記データを全削除"
          className="flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
        >
          {busy === 'delete' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          全削除
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.CSV,text/csv,application/vnd.ms-excel"
          onChange={handleFileChosen}
          className="hidden"
        />
      </div>

      {progress && (
        <div className="flex items-center gap-2 border-b bg-blue-50 px-4 py-1 text-xs text-blue-800">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            {progress.phase}
            {progress.total > 0 && (
              <>
                <span className="ml-1 font-mono">
                  {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
                </span>
                <span className="ml-1 text-blue-600">
                  ({Math.round((progress.done / progress.total) * 100)}%)
                </span>
              </>
            )}
          </span>
          {progress.total > 0 && (
            <div className="h-2 w-32 overflow-hidden rounded bg-blue-100">
              <div
                className="h-full bg-blue-500 transition-[width] duration-150"
                style={{
                  width: `${Math.min(100, (progress.done / progress.total) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}
      {!progress && message && (
        <div className="border-b bg-emerald-50 px-4 py-1 text-xs text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="border-b bg-red-50 px-4 py-1 text-xs text-red-800">{error}</div>
      )}
      {source && (
        <div className="flex items-center gap-2 border-b bg-slate-50 px-4 py-1 text-xs text-slate-600">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          <span>{source}</span>
          <span className="text-slate-400">
            全 {records.length} 件 / 表示 {filtered.length} 件
          </span>
        </div>
      )}

      {records.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-sm">
          <FileSpreadsheet className="h-8 w-8 text-slate-300" />
          <div>右上の「登記CSV読込」から CSV を選んでください</div>
          <div className="text-xs">対応: 法務局 4600 形式 (Shift-JIS)</div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  <th className="border-b px-2 py-1 text-right w-14">連番</th>
                  <th className="border-b px-2 py-1 w-12 text-left">種別</th>
                  <th className="border-b px-2 py-1 text-left w-24">工区</th>
                  <th className="border-b px-2 py-1 text-left">所在</th>
                  <th className="border-b px-2 py-1 text-left w-24">地番</th>
                  <th className="border-b px-2 py-1 text-left w-14">地目</th>
                  <th className="border-b px-2 py-1 text-right w-20">地積</th>
                  <th className="border-b px-2 py-1 text-left">所有者</th>
                  <th className="border-b px-2 py-1 text-left w-32">一次立会</th>
                  <th className="border-b px-2 py-1 text-left w-20">状況</th>
                  <th className="border-b px-2 py-1 text-left w-32">二次立会</th>
                  <th className="border-b px-2 py-1 text-left w-20">状況</th>
                  <th className="border-b px-2 py-1 text-left w-36">不動産番号</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const p = r.property
                  const { landCategory, areaText } = latestDisplay(r)
                  const owners = ownerSummary(r)
                  const active = r.seq === selectedSeq
                  const ex = r.extras
                  return (
                    <tr
                      key={r.seq}
                      onClick={() => setSelectedSeq(r.seq)}
                      className={`cursor-pointer border-b hover:bg-blue-50 ${
                        active ? 'bg-blue-100' : ''
                      }`}
                    >
                      <td className="px-2 py-1 text-right font-mono text-slate-500">
                        {r.seq}
                      </td>
                      <td className="px-2 py-1 text-slate-700">{p?.kind ?? ''}</td>
                      <td className="px-2 py-1 text-slate-700 truncate max-w-[6rem]" title={ex?.farmName ?? ''}>
                        {ex?.farmName ?? '—'}
                      </td>
                      <td className="px-2 py-1">{p?.location ?? ''}</td>
                      <td className="px-2 py-1 font-mono">{p?.parcelNumber ?? ''}</td>
                      <td className="px-2 py-1">{landCategory}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {areaText}
                      </td>
                      <td
                        className="px-2 py-1 truncate max-w-[14rem]"
                        title={owners}
                      >
                        {owners}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-600">
                        {formatVisitAt(ex?.firstVisitAt ?? null)}
                      </td>
                      <td className="px-2 py-1 text-slate-700">
                        {formatVisitStatus(ex?.firstVisitStatus ?? null)}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-600">
                        {formatVisitAt(ex?.secondVisitAt ?? null)}
                      </td>
                      <td className="px-2 py-1 text-slate-700">
                        {formatVisitStatus(ex?.secondVisitStatus ?? null)}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-500">
                        {p?.realEstateNumber ?? ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {selected && (
            <DetailPanel
              record={selected}
              farms={projectFarms}
              onClose={() => setSelectedSeq(null)}
              onAssignFarm={(farmId) => {
                const pid = selected.extras?.id
                if (pid) void handleAssignFarm(pid, farmId)
              }}
            />
          )}
        </div>
      )}

    </div>
  )
}

function DetailPanel({
  record,
  farms,
  onClose,
  onAssignFarm,
}: {
  record: RegistryRecord
  farms: Array<{ id: string; name: string }>
  onClose: () => void
  onAssignFarm: (farmId: string | null) => void
}) {
  const p = record.property
  const ex = record.extras
  return (
    <div className="w-[26rem] border-l bg-slate-50 overflow-auto flex-shrink-0">
      <div className="flex items-center justify-between border-b bg-white px-3 py-2">
        <div className="text-sm font-semibold">
          #{record.seq} {p?.location} {p?.parcelNumber}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-slate-100"
          title="閉じる"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {p && (
        <Section title="物件情報">
          <KV k="種別" v={p.kind} />
          <KV k="状態" v={p.status} />
          <KV k="所在" v={p.location} />
          <KV k="地番" v={p.parcelNumber} mono />
          <KV k="不動産番号" v={p.realEstateNumber} mono />
        </Section>
      )}

      <Section title="工区">
        <li className="flex gap-2 px-3 py-1.5 text-xs items-center">
          <span className="w-20 flex-shrink-0 text-slate-500">割当</span>
          <select
            value={ex?.farmId ?? ''}
            onChange={(e) => onAssignFarm(e.target.value || null)}
            className="flex-1 rounded border px-1 py-0.5 text-xs"
          >
            <option value="">(未割当)</option>
            {farms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </li>
      </Section>

      <Section title={`所在履歴 (${record.locations.length})`}>
        {record.locations.map((l) => (
          <Row
            key={`loc-${l.order}`}
            head={String(l.order)}
            main={l.value}
            sub={[l.changeReason, l.registeredAt].filter(Boolean).join(' / ')}
          />
        ))}
      </Section>

      <Section title={`表示履歴 (${record.displayHistories.length})`}>
        {record.displayHistories.map((d) => (
          <Row
            key={`dh-${d.order}`}
            head={String(d.order)}
            main={`${d.parcelNumber || '—'} / ${d.landCategory || '—'} / ${d.areaText || '—'}`}
            sub={[d.reason, d.causeDate].filter(Boolean).join(' / ')}
          />
        ))}
      </Section>

      <Section title={`所有権 (${record.ownerships.length})`}>
        {record.ownerships.map((o) => (
          <Row
            key={`ow-${o.order}`}
            head={String(o.order)}
            main={`${o.ownerName}${o.share ? `（${o.share}）` : ''}`}
            sub={[
              o.address,
              [o.receivedAt, o.receiptNumber].filter(Boolean).join(' '),
            ]
              .filter(Boolean)
              .join(' / ')}
          />
        ))}
      </Section>

      <Section title={`甲区 (${record.kouku.length})`}>
        {record.kouku.map((k) => (
          <Row
            key={`kou-${k.order}`}
            head={k.rank || String(k.order)}
            main={k.purpose}
            sub={[
              [k.receivedAt, k.receiptNumber].filter(Boolean).join(' '),
              k.detail,
            ]
              .filter(Boolean)
              .join(' / ')}
          />
        ))}
      </Section>

      <Section title={`乙区 (${record.otoku.length})`}>
        {record.otoku.map((k) => (
          <Row
            key={`ot-${k.order}`}
            head={k.rank || String(k.order)}
            main={k.purpose}
            sub={[
              [k.receivedAt, k.receiptNumber].filter(Boolean).join(' '),
              k.detail,
            ]
              .filter(Boolean)
              .join(' / ')}
          />
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children
  if (!hasChildren) return null
  return (
    <div className="border-b">
      <div className="bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        {title}
      </div>
      <ul className="divide-y">{children}</ul>
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <li className="flex gap-2 px-3 py-1.5 text-xs">
      <span className="w-20 flex-shrink-0 text-slate-500">{k}</span>
      <span className={`flex-1 text-slate-800 ${mono ? 'font-mono' : ''}`}>
        {v || '—'}
      </span>
    </li>
  )
}

function Row({
  head,
  main,
  sub,
}: {
  head: string
  main: string
  sub: string
}) {
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex gap-2">
        <span className="w-8 flex-shrink-0 text-slate-400 font-mono">
          {head}
        </span>
        <span className="flex-1 text-slate-800 break-words">{main || '—'}</span>
      </div>
      {sub && (
        <div className="mt-0.5 pl-10 text-[11px] text-slate-500 break-words">
          {sub}
        </div>
      )}
    </li>
  )
}
