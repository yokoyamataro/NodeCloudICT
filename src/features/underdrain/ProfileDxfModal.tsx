import { useEffect, useMemo, useState } from 'react'
import { X, Download, PenTool } from 'lucide-react'
import type { PlanGroup, PlanRow } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import { exportAllCrossSectionsDxf } from '@/lib/crossSectionDxfExport'

const PROFILE_DXF_SCALE_KEY = 'nodecloud:profile-dxf-scale'

type ProfileScale = 100 | 200 | 500 | 1000
const DEFAULT_SCALE: ProfileScale = 200

function loadScale(): ProfileScale {
  if (typeof window === 'undefined') return DEFAULT_SCALE
  try {
    const raw = window.localStorage.getItem(PROFILE_DXF_SCALE_KEY)
    if (!raw) return DEFAULT_SCALE
    const n = parseInt(raw, 10)
    if (n === 100 || n === 200 || n === 500 || n === 1000) return n
    return DEFAULT_SCALE
  } catch {
    return DEFAULT_SCALE
  }
}

interface ProfileDxfModalProps {
  open: boolean
  onClose: () => void
  pipes: PipeRow[]
  planGroups: PlanGroup[]
  farmName: string | null
}

export function ProfileDxfModal({
  open,
  onClose,
  pipes,
  planGroups,
  farmName,
}: ProfileDxfModalProps) {
  const [dxfVScale, setDxfVScale] = useState<ProfileScale>(DEFAULT_SCALE)

  useEffect(() => {
    if (!open) return
    setDxfVScale(loadScale())
  }, [open])

  useEffect(() => {
    if (!open) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(PROFILE_DXF_SCALE_KEY, String(dxfVScale))
    } catch {
      // ignore
    }
  }, [open, dxfVScale])

  // 縦断図用の補助マップ
  const pipeNumberById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of pipes) m.set(p.id, p.number)
    return m
  }, [pipes])
  const pipeDiameterById = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of pipes) if (p.diameter != null) m.set(p.id, p.diameter)
    return m
  }, [pipes])

  // 全系統 × 全行のフラットなタブリスト
  const flatTabs = useMemo(() => {
    const tabs: Array<{
      systemRows: PlanRow[]
      systemIndex: number
      endType: 'outlet' | 'merge' | null
      groupName: string
    }> = []
    for (const group of planGroups) {
      const bySys = new Map<number, { rows: PlanRow[]; endType: 'outlet' | 'merge' | null }>()
      for (const r of group.rows) {
        const k = r.systemIndex ?? 1
        const cur = bySys.get(k) ?? { rows: [], endType: null }
        cur.rows.push(r)
        if (r.isSystemEnd && r.systemEndType) cur.endType = r.systemEndType
        bySys.set(k, cur)
      }
      for (const [systemIndex, info] of bySys) {
        tabs.push({
          systemRows: info.rows,
          systemIndex,
          endType: info.endType,
          groupName: group.name,
        })
      }
    }
    return tabs
  }, [planGroups])

  if (!open) return null

  const handleExport = () => {
    if (flatTabs.length === 0) {
      alert('施工計画がありません。施工計画ページで生成してください。')
      return
    }
    exportAllCrossSectionsDxf({
      systems: flatTabs,
      verticalScale: dxfVScale,
      pipeNumberById,
      pipeDiameterById,
      allPlanGroups: planGroups,
      farmName: farmName ?? undefined,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <PenTool className="h-5 w-5 text-sky-600" />
            縦断図 DXF 一括出力
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div className="text-xs text-slate-600">
            全系統の集水縦断図を 1 つの DXF ファイルに縦並びで出力します。
          </div>
          <label className="flex items-center gap-2">
            <span className="text-slate-600">縦縮尺</span>
            <select
              value={dxfVScale}
              onChange={(e) =>
                setDxfVScale(parseInt(e.target.value, 10) as ProfileScale)
              }
              className="px-2 py-1 text-sm border rounded bg-white"
            >
              <option value={100}>1/100</option>
              <option value={200}>1/200</option>
              <option value={500}>1/500</option>
              <option value={1000}>1/1000</option>
            </select>
          </label>
          <div className="text-xs text-slate-600 border rounded p-2 bg-slate-50">
            {flatTabs.length === 0
              ? '施工計画がありません'
              : `系統 ${flatTabs.length} 件を出力します`}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            disabled={flatTabs.length === 0}
            className="px-4 py-2 text-sm bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            出力
          </button>
        </div>
      </div>
    </div>
  )
}
