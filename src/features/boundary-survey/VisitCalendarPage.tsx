// 立会カレンダー。
//
// 縦: 時刻 (15 分 刻み、default 07:00〜19:00)。
// 横: 選択日 を 中心 と した 週 (Mon〜Sun 7 列)。
//
// データ: parcel_landowners.first_visit_at / second_visit_at (現 farm 内)。
// 一次 = 青、二次 = 橙 の チップ で 表示。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { supabase } from '@/lib/supabase'

const sb = supabase as unknown as {
  from: (t: string) => {
    select: (cols: string) => any
  }
}

interface VisitEntry {
  share_id: string   // parcel_landowners row の 疑似 key (parcel_id + landowner_id)
  parcel_id: string
  parcel_number: string
  landowner_id: string
  landowner_name: string
  visit_at: string
  visit_status: string
  visit_kind: 'first' | 'second'
}

const START_HOUR = 7
const END_HOUR = 19
const SLOT_MIN = 15
const SLOTS_PER_HOUR = 60 / SLOT_MIN
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const startOfDay = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const startOfWeek = (d: Date) => {
  const x = startOfDay(d)
  const dow = x.getDay()
  const back = dow === 0 ? 6 : dow - 1
  return addDays(x, -back)
}
const slotIndexOf = (iso: string): number | null => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const h = d.getHours()
  const m = d.getMinutes()
  if (h < START_HOUR || h >= END_HOUR) return null
  return (h - START_HOUR) * SLOTS_PER_HOUR + Math.floor(m / SLOT_MIN)
}
const slotLabel = (slot: number): string => {
  const h = Math.floor(slot / SLOTS_PER_HOUR) + START_HOUR
  const m = (slot % SLOTS_PER_HOUR) * SLOT_MIN
  return `${pad(h)}:${pad(m)}`
}

export function VisitCalendarPage() {
  const { currentFarm } = useFarmStore()
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()))
  const [visits, setVisits] = useState<VisitEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const range = useMemo(() => {
    const from = startOfWeek(anchorDate)
    const to = addDays(from, 7)
    return { from, to }
  }, [anchorDate])

  const load = useCallback(async () => {
    if (!currentFarm) return
    setLoading(true)
    setError(null)
    try {
      // parcel_landowners の 一次/二次 を それぞれ 期間 で フィルタ。
      // parcels 経由 で 現 farm の 分 に 絞る。
      const fetchOne = async (
        field: 'first_visit_at' | 'second_visit_at',
        statusField: 'first_visit_status' | 'second_visit_status',
        kind: 'first' | 'second',
      ): Promise<VisitEntry[]> => {
        const { data, error: err } = await sb
          .from('parcel_landowners')
          .select(
            `parcel_id, landowner_id, ${field}, ${statusField},
             parcels!inner(parcel_number, design_work_areas!inner(farm_id)),
             landowners!inner(full_name)`,
          )
          .eq('parcels.design_work_areas.farm_id', currentFarm.id)
          .gte(field, range.from.toISOString())
          .lt(field, range.to.toISOString())
        if (err) throw err
        const out: VisitEntry[] = []
        for (const row of (data ?? []) as Array<{
          parcel_id: string
          landowner_id: string
          first_visit_at?: string | null
          first_visit_status?: string | null
          second_visit_at?: string | null
          second_visit_status?: string | null
          parcels: { parcel_number: string } | { parcel_number: string }[]
          landowners: { full_name: string } | { full_name: string }[]
        }>) {
          const rowAny = row as unknown as Record<string, string | null>
          const visitAt = rowAny[field]
          if (!visitAt) continue
          const parcels = Array.isArray(row.parcels) ? row.parcels[0] : row.parcels
          const landowners = Array.isArray(row.landowners)
            ? row.landowners[0]
            : row.landowners
          out.push({
            share_id: `${row.parcel_id}-${row.landowner_id}-${kind}`,
            parcel_id: row.parcel_id,
            parcel_number: parcels?.parcel_number ?? '',
            landowner_id: row.landowner_id,
            landowner_name: landowners?.full_name ?? '',
            visit_at: visitAt,
            visit_status: rowAny[statusField] ?? '',
            visit_kind: kind,
          })
        }
        return out
      }

      const [firsts, seconds] = await Promise.all([
        fetchOne('first_visit_at', 'first_visit_status', 'first'),
        fetchOne('second_visit_at', 'second_visit_status', 'second'),
      ])
      setVisits([...firsts, ...seconds])
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : '立会予定の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [currentFarm, range.from, range.to])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(range.from, i)
      return {
        key: ymd(day),
        label: `${day.getMonth() + 1}/${day.getDate()}`,
        subLabel: ['月', '火', '水', '木', '金', '土', '日'][i],
      }
    })
  }, [range.from])

  const cellMap = useMemo(() => {
    const m = new Map<string, VisitEntry[]>()
    for (const v of visits) {
      const slot = slotIndexOf(v.visit_at)
      if (slot == null) continue
      const dayKey = ymd(new Date(v.visit_at))
      const key = `${dayKey}|${slot}`
      const arr = m.get(key) ?? []
      arr.push(v)
      m.set(key, arr)
    }
    return m
  }, [visits])

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
        <div className="text-sm font-semibold text-slate-700">立会カレンダー</div>
        <div className="text-xs text-slate-500">
          (縦 15 分刻み / 一次=青、二次=橙)
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAnchorDate((d) => addDays(d, -7))}
          className="rounded border p-1 hover:bg-slate-50"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <input
          type="date"
          value={ymd(anchorDate)}
          onChange={(e) => {
            const d = new Date(e.target.value + 'T00:00:00')
            if (!Number.isNaN(d.getTime())) setAnchorDate(d)
          }}
          className="rounded border px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={() => setAnchorDate((d) => addDays(d, 7))}
          className="rounded border p-1 hover:bg-slate-50"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setAnchorDate(startOfDay(new Date()))}
          className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
        >
          今週
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 border-b bg-blue-50 px-4 py-1 text-xs text-blue-800">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          読み込み中...
        </div>
      )}
      {error && (
        <div className="border-b bg-red-50 px-4 py-1 text-xs text-red-800">{error}</div>
      )}

      <div className="flex-1 overflow-auto bg-slate-50">
        <div
          className="grid text-xs bg-white"
          style={{
            gridTemplateColumns: `4rem repeat(${columns.length}, minmax(9rem, 1fr))`,
          }}
        >
          <div className="sticky top-0 z-10 border-b border-r bg-slate-100 px-2 py-1 text-slate-500">
            時刻
          </div>
          {columns.map((c) => (
            <div
              key={c.key}
              className="sticky top-0 z-10 border-b border-r bg-slate-100 px-2 py-1 text-slate-700"
            >
              <div className="font-semibold">{c.label}</div>
              <div className="text-[10px] text-slate-500">{c.subLabel}</div>
            </div>
          ))}
          {Array.from({ length: TOTAL_SLOTS }, (_, slot) => (
            <TimeRow
              key={slot}
              slot={slot}
              columns={columns}
              cellMap={cellMap}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function TimeRow({
  slot,
  columns,
  cellMap,
}: {
  slot: number
  columns: Array<{ key: string }>
  cellMap: Map<string, VisitEntry[]>
}) {
  const isHour = slot % SLOTS_PER_HOUR === 0
  return (
    <>
      <div
        className={`border-r px-2 py-1 text-slate-500 font-mono ${
          isHour ? 'border-t bg-slate-50 font-semibold' : ''
        }`}
      >
        {isHour ? slotLabel(slot) : ''}
      </div>
      {columns.map((c) => {
        const list = cellMap.get(`${c.key}|${slot}`) ?? []
        return (
          <div
            key={c.key}
            className={`border-r ${isHour ? 'border-t' : ''} px-1 py-0.5 min-h-[1.5rem]`}
          >
            <div className="flex flex-col gap-0.5">
              {list.map((v) => (
                <VisitChip key={v.share_id} entry={v} />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function VisitChip({ entry }: { entry: VisitEntry }) {
  const color =
    entry.visit_kind === 'first'
      ? 'bg-blue-100 border-blue-300 text-blue-900'
      : 'bg-orange-100 border-orange-300 text-orange-900'
  const time = new Date(entry.visit_at)
  const label = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  const tooltip = [
    `${entry.visit_kind === 'first' ? '一次' : '二次'} 立会`,
    entry.parcel_number,
    entry.landowner_name,
    entry.visit_status || '(状況未設定)',
    label,
  ].join(' / ')
  return (
    <div
      className={`rounded border px-1 py-0.5 text-[10px] leading-tight truncate ${color}`}
      title={tooltip}
    >
      <span className="font-mono">{label}</span>
      <span className="ml-1 font-semibold">{entry.parcel_number}</span>
      {entry.landowner_name && <span className="ml-1">{entry.landowner_name}</span>}
    </div>
  )
}
