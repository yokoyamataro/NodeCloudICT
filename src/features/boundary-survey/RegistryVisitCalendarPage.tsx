// 法務局備付地図作成作業 > 立会カレンダー。
//
// 縦: 時刻 (15 分 刻み、default 07:00〜19:00)。
// 横: 「日付」 モード → 週 (Mon〜Sun) の 7 列 / 「工区」 モード → 選択日 の 全工区。
//
// データ: property_owner_shares の first_visit_at / second_visit_at を
// 参照。 一次 = 青、二次 = 橙 で 塗り分け。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  fetchVisitsForCalendar,
  type VisitCalendarEntry,
} from '@/lib/registryCsvSave'

type Mode = 'date' | 'farm'

interface Column {
  key: string
  label: string
  subLabel?: string
  filter: (v: VisitCalendarEntry) => boolean
}

const START_HOUR = 7
const END_HOUR = 19
const SLOT_MIN = 15
const SLOTS_PER_HOUR = 60 / SLOT_MIN
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

// 週 の 始まり (月曜)
function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  const dow = x.getDay() // 0=日
  const back = dow === 0 ? 6 : dow - 1
  return addDays(x, -back)
}

function slotIndexOf(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const h = d.getHours()
  const m = d.getMinutes()
  if (h < START_HOUR || h >= END_HOUR) return null
  return (h - START_HOUR) * SLOTS_PER_HOUR + Math.floor(m / SLOT_MIN)
}

function slotLabel(slot: number): string {
  const h = Math.floor(slot / SLOTS_PER_HOUR) + START_HOUR
  const m = (slot % SLOTS_PER_HOUR) * SLOT_MIN
  return `${pad(h)}:${pad(m)}`
}

export function RegistryVisitCalendarPage() {
  const { currentFarm, farms } = useFarmStore()
  const projectId = currentFarm?.project_id ?? null
  const projectFarms = useMemo(
    () => farms.filter((f) => f.project_id === projectId),
    [farms, projectId],
  )

  const [mode, setMode] = useState<Mode>('date')
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()))
  const [visits, setVisits] = useState<VisitCalendarEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // モード に 応じた 期間 (fromIso, toIso)
  const range = useMemo(() => {
    if (mode === 'date') {
      const from = startOfWeek(anchorDate)
      const to = addDays(from, 7)
      return { from, to }
    }
    return { from: startOfDay(anchorDate), to: addDays(startOfDay(anchorDate), 1) }
  }, [mode, anchorDate])

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchVisitsForCalendar(
        projectId,
        range.from.toISOString(),
        range.to.toISOString(),
      )
      setVisits(rows)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : '立会予定の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [projectId, range.from, range.to])

  useEffect(() => {
    void load()
  }, [load])

  // 列 定義 (モード に 応じ 動的)
  const columns = useMemo<Column[]>(() => {
    if (mode === 'date') {
      const from = range.from
      return Array.from({ length: 7 }, (_, i) => {
        const day = addDays(from, i)
        const key = ymd(day)
        return {
          key,
          label: `${day.getMonth() + 1}/${day.getDate()}`,
          subLabel: ['月', '火', '水', '木', '金', '土', '日'][i],
          filter: (v) => {
            const d = new Date(v.visit_at)
            return ymd(d) === key
          },
        }
      })
    }
    return [
      {
        key: 'none',
        label: '(未割当)',
        filter: (v) => v.farm_id == null,
      },
      ...projectFarms.map((f): Column => ({
        key: f.id,
        label: f.name,
        filter: (v) => v.farm_id === f.id,
      })),
    ]
  }, [mode, range.from, projectFarms])

  // 行 × 列 に 割り当て
  const cellMap = useMemo(() => {
    const m = new Map<string, VisitCalendarEntry[]>()
    for (const v of visits) {
      const slot = slotIndexOf(v.visit_at)
      if (slot == null) continue
      const col = columns.find((c) => c.filter(v))
      if (!col) continue
      const key = `${col.key}|${slot}`
      const arr = m.get(key) ?? []
      arr.push(v)
      m.set(key, arr)
    }
    return m
  }, [visits, columns])

  const shiftBy = (n: number) => {
    setAnchorDate((d) => addDays(d, mode === 'date' ? n * 7 : n))
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
        <div className="text-sm font-semibold text-slate-700">立会カレンダー</div>
        <div className="text-xs text-slate-500">
          (縦 15 分刻み / 一次=青、二次=橙)
        </div>
        <div className="flex-1" />

        <div className="flex overflow-hidden rounded border text-xs">
          <button
            type="button"
            onClick={() => setMode('date')}
            className={`px-2 py-1 ${
              mode === 'date' ? 'bg-blue-600 text-white' : 'bg-white hover:bg-slate-50'
            }`}
          >
            日付
          </button>
          <button
            type="button"
            onClick={() => setMode('farm')}
            className={`px-2 py-1 ${
              mode === 'farm' ? 'bg-blue-600 text-white' : 'bg-white hover:bg-slate-50'
            }`}
          >
            工区
          </button>
        </div>

        <button
          type="button"
          onClick={() => shiftBy(-1)}
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
          onClick={() => shiftBy(1)}
          className="rounded border p-1 hover:bg-slate-50"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setAnchorDate(startOfDay(new Date()))}
          className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
        >
          今日
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
          {/* ヘッダー */}
          <div className="sticky top-0 z-10 border-b border-r bg-slate-100 px-2 py-1 text-slate-500">
            時刻
          </div>
          {columns.map((c) => (
            <div
              key={c.key}
              className="sticky top-0 z-10 border-b border-r bg-slate-100 px-2 py-1 text-slate-700"
            >
              <div className="font-semibold">{c.label}</div>
              {c.subLabel && (
                <div className="text-[10px] text-slate-500">{c.subLabel}</div>
              )}
            </div>
          ))}
          {/* 本体 */}
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
  columns: Array<{ key: string; label: string }>
  cellMap: Map<string, VisitCalendarEntry[]>
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
                <VisitChip key={v.share_id + '-' + v.visit_kind} entry={v} />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function VisitChip({ entry }: { entry: VisitCalendarEntry }) {
  const color =
    entry.visit_kind === 'first'
      ? 'bg-blue-100 border-blue-300 text-blue-900'
      : 'bg-orange-100 border-orange-300 text-orange-900'
  const time = new Date(entry.visit_at)
  const label = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  const tooltip = [
    `${entry.visit_kind === 'first' ? '一次' : '二次'} 立会`,
    entry.parcel_number,
    entry.owner_name,
    entry.farm_name ?? '(工区未割当)',
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
      {entry.owner_name && <span className="ml-1">{entry.owner_name}</span>}
    </div>
  )
}
