// 法務局備付地図作成作業 ページ。
//
// 第 1 段: 登記 CSV (法務局 4600 形式 / Shift-JIS) を 選択 → 一覧 表示 まで。
// パース は @/lib/registryCsv、保存 は しない (メモリ のみ)。
// 行 クリック で 右側 に 所在履歴 / 表示履歴 / 所有権 / 甲区 / 乙区 を 詳細表示。

import { useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, Loader2, Upload, X } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  latestDisplay,
  ownerSummary,
  parseRegistryCsv,
  readRegistryCsvFile,
  type RegistryRecord,
} from '@/lib/registryCsv'

export function RegistryMapWorkPage() {
  const { currentFarm } = useFarmStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<RegistryRecord[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

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

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const text = await readRegistryCsvFile(file)
      const parsed = parseRegistryCsv(text)
      setRecords(parsed.records)
      setSource(file.name)
      setSelectedSeq(null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'CSV 読込に失敗しました')
    } finally {
      setBusy(false)
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
          disabled={busy}
          className="flex items-center gap-1 rounded border bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          登記CSV読込
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.CSV,text/csv,application/vnd.ms-excel"
          onChange={handleFileChosen}
          className="hidden"
        />
      </div>

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
                  <th className="border-b px-2 py-1 text-left">所在</th>
                  <th className="border-b px-2 py-1 text-left w-28">地番</th>
                  <th className="border-b px-2 py-1 text-left w-16">地目</th>
                  <th className="border-b px-2 py-1 text-right w-24">地積</th>
                  <th className="border-b px-2 py-1 text-left">所有者</th>
                  <th className="border-b px-2 py-1 text-left w-40">不動産番号</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const p = r.property
                  const { landCategory, areaText } = latestDisplay(r)
                  const owners = ownerSummary(r)
                  const active = r.seq === selectedSeq
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
                      <td className="px-2 py-1">{p?.location ?? ''}</td>
                      <td className="px-2 py-1 font-mono">{p?.parcelNumber ?? ''}</td>
                      <td className="px-2 py-1">{landCategory}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {areaText}
                      </td>
                      <td
                        className="px-2 py-1 truncate max-w-[16rem]"
                        title={owners}
                      >
                        {owners}
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
              onClose={() => setSelectedSeq(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function DetailPanel({
  record,
  onClose,
}: {
  record: RegistryRecord
  onClose: () => void
}) {
  const p = record.property
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
