// 地番管理データを CSV 出力するモーダル。
// 列は CADASTRAL_COLUMN_KEYS からユーザーが選択でき、選択は localStorage に永続化。
// 出力元データは workAreaStore / parcelStore / landownerStore の現工区状態を利用。

import { useState } from 'react'
import { Check, Download, X } from 'lucide-react'
import {
  CADASTRAL_COLUMN_KEYS,
  CADASTRAL_COLUMN_LABELS,
  type CadastralColumnKey,
} from './CadastralRowFields'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useLandownerStore } from '@/stores/landownerStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'

const STORAGE_KEY = 'cadastral:csvExportColumns'

function loadSelected(): Set<CadastralColumnKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set(CADASTRAL_COLUMN_KEYS)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set(CADASTRAL_COLUMN_KEYS)
    const valid = (arr as unknown[]).filter((k): k is CadastralColumnKey =>
      (CADASTRAL_COLUMN_KEYS as readonly string[]).includes(k as string),
    )
    return valid.length > 0 ? new Set(valid) : new Set(CADASTRAL_COLUMN_KEYS)
  } catch {
    return new Set(CADASTRAL_COLUMN_KEYS)
  }
}

function saveSelected(set: Set<CadastralColumnKey>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    /* ignore */
  }
}

function escapeCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// 3 位以下切捨 → 小数 2 桁
function truncate2(n: number): string {
  return (Math.floor(n * 100) / 100).toFixed(2)
}

function downloadCsv(filename: string, csvContent: string) {
  // BOM を付けて Excel でも文字化けしないようにする
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

interface Props {
  onClose: () => void
}

export function CadastralCsvExportModal({ onClose }: Props) {
  const [selected, setSelected] = useState<Set<CadastralColumnKey>>(() => loadSelected())
  const [exporting, setExporting] = useState(false)

  const currentFarm = useFarmStore((s) => s.currentFarm)
  const projects = useProjectListStore((s) => s.projects)
  const workAreas = useWorkAreaStore((s) => s.workAreas['boundary_survey'] ?? [])
  const parcels = useParcelStore((s) => s.byWorkAreaId)
  const landowners = useLandownerStore((s) => s.landowners)
  const assignments = useLandownerStore((s) => s.landownersByParcelId)

  const project = currentFarm ? projects.find((p) => p.id === currentFarm.project_id) : null

  const toggle = (key: CadastralColumnKey) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const setAll = (on: boolean) => {
    setSelected(on ? new Set(CADASTRAL_COLUMN_KEYS) : new Set())
  }

  const handleExport = () => {
    if (!currentFarm || selected.size === 0) return
    setExporting(true)
    try {
      // 表示順は CADASTRAL_COLUMN_KEYS の並びを維持
      const columns = CADASTRAL_COLUMN_KEYS.filter((k) => selected.has(k))
      const header = columns.map((k) => CADASTRAL_COLUMN_LABELS[k])

      // 地番順に並べる（parcel_number > area.zoneNumber、日本語自然順）
      const sortedAreas = [...workAreas].sort((a, b) => {
        const pa = parcels.get(a.id)
        const pb = parcels.get(b.id)
        const na = (pa?.parcel_number ?? a.zoneNumber ?? '').trim()
        const nb = (pb?.parcel_number ?? b.zoneNumber ?? '').trim()
        return na.localeCompare(nb, 'ja', { numeric: true })
      })

      const rows: string[][] = [header]
      for (const area of sortedAreas) {
        const parcel = parcels.get(area.id)
        const parcelId = parcel?.id
        const assignedNames = parcelId
          ? (assignments.get(parcelId) ?? [])
              .map((lid) => landowners.find((l) => l.id === lid)?.full_name ?? '')
              .filter(Boolean)
          : []
        const row = columns.map((k) => {
          switch (k) {
            case 'location':
              return parcel?.location ?? ''
            case 'parcel_number':
              return parcel?.parcel_number ?? area.zoneNumber ?? ''
            case 'registered_land_category':
              return parcel?.registered_land_category ?? ''
            case 'registered_area_sqm':
              return parcel?.registered_area_sqm == null
                ? ''
                : String(parcel.registered_area_sqm)
            case 'updated_land_category':
              return parcel?.updated_land_category ?? ''
            case 'updated_area_sqm':
              return parcel?.updated_area_sqm == null
                ? ''
                : String(parcel.updated_area_sqm)
            case 'registered_owner_name':
              return parcel?.registered_owner_name ?? ''
            case 'registered_owner_address':
              return parcel?.registered_owner_address ?? ''
            case 'landowners':
              return assignedNames.join('、')
            case 'points_count':
              return String(area.points.length)
            case 'computed_area_sqm':
              return area.areaSqm !== null ? truncate2(area.areaSqm) : ''
            default:
              return ''
          }
        })
        rows.push(row)
      }

      const csv = rows.map((r) => r.map(escapeCsv).join(',')).join('\r\n')

      // ファイル名: {現場名}_{工区名}_地番_{yyyymmdd}.csv
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const projName = project?.name ?? '工事'
      const farmName = currentFarm.name ?? '工区'
      const filename = `${projName}_${farmName}_地番_${y}${m}${d}.csv`.replace(
        /[<>:"/\\|?*]/g,
        '_',
      )

      downloadCsv(filename, csv)
      saveSelected(selected)
      onClose()
    } finally {
      setExporting(false)
    }
  }

  const disabled =
    exporting || !currentFarm || selected.size === 0 || workAreas.length === 0

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">地番データを CSV 出力</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-3 border-b">
          <div className="text-xs text-slate-600">
            {currentFarm ? (
              <>
                <span className="font-medium">{project?.name}</span>
                {' / '}
                <span className="font-medium">{currentFarm.name}</span>
                <span className="text-slate-400"> — 地番 {workAreas.length} 件</span>
              </>
            ) : (
              '工区が選択されていません'
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-b flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600">
            出力する列 ({selected.size}/{CADASTRAL_COLUMN_KEYS.length})
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setAll(true)}
              className="text-[10px] px-2 py-0.5 border rounded hover:bg-slate-50"
            >
              全選択
            </button>
            <button
              onClick={() => setAll(false)}
              className="text-[10px] px-2 py-0.5 border rounded hover:bg-slate-50"
            >
              全解除
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2 max-h-72">
          {CADASTRAL_COLUMN_KEYS.map((key) => {
            const on = selected.has(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded ${
                  on ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-4 h-4 border rounded ${
                    on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span>{CADASTRAL_COLUMN_LABELS[key]}</span>
              </button>
            )
          })}
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={exporting}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            disabled={disabled}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {exporting ? '出力中…' : 'CSV を出力'}
          </button>
        </div>
      </div>
    </div>
  )
}
