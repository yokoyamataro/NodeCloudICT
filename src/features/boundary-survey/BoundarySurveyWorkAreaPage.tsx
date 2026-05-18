// 境界測量: 地番データ（座標 + 画地ポリゴン）の SIMA 入出力対応
//
// SIMA インポート: 座標 → design_coordinates (type='boundary'), 画地 → design_work_areas
// SIMA エクスポート: 現工区の boundary 座標 + boundary_survey 工事区域を出力

import { useRef, useState } from 'react'
import { Download, Upload, Loader2 } from 'lucide-react'
import { GenericWorkAreaPage } from '@/components/work-area/GenericWorkAreaPage'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import {
  loadSimaFile,
  downloadSimaFile,
  type SimaExportPolygon,
} from '@/lib/sima-parser'
import { supabase } from '@/lib/supabase'
import type { CoordinateRow } from '@/stores/coordinateStore'
import type { DesignWorkArea } from '@/types/database'

export function BoundarySurveyWorkAreaPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'import' | 'export' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates, importCoordinates } = useCoordinateStore()
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()

  const project = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)
    : null
  const zone = project?.coordinate_zone ?? 13

  const handleOpenImport = () => fileRef.current?.click()

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !currentFarm) return
    setBusy('import')
    setMessage(null)
    try {
      const result = await loadSimaFile(file)

      // 1) 座標を boundary 種別で取り込み（既存の同点番号はスキップ）
      const existingNumbers = new Set(coordinates.map((c) => c.pointNumber))
      const newCoords = result.coordinates
        .filter((c) => !existingNumbers.has(c.pointNumber))
        .map((c) => ({
          pointNumber: c.pointNumber,
          x: c.x,
          y: c.y,
          z: c.z,
          type: 'boundary' as unknown as CoordinateRow['type'],
        }))

      let insertedCoords: CoordinateRow[] = []
      if (newCoords.length > 0) {
        insertedCoords = await importCoordinates(newCoords)
      }

      // 2) 全座標（既存 + 新規）から 点番号 → ID マップを作る
      // 即時反映のために再 fetch する
      await fetchCoordinates(currentFarm.id)
      const fresh = useCoordinateStore.getState().coordinates
      const idByName = new Map<string, string>()
      for (const c of fresh) idByName.set(c.pointNumber, c.id)
      // insertedCoords は state 反映前の値の場合があるためフォールバック
      for (const c of insertedCoords) {
        if (!idByName.has(c.pointNumber)) idByName.set(c.pointNumber, c.id)
      }

      // 3) 画地を design_work_areas に挿入（work_type='boundary_survey'）
      let createdPolygons = 0
      let skippedPolygons = 0
      for (const poly of result.polygons) {
        const pointIds = poly.pointNumbers
          .map((pn) => idByName.get(pn))
          .filter((id): id is string => !!id)
        if (pointIds.length < 3) {
          skippedPolygons++
          continue
        }
        // 地番名（D00 の 3 列目）を優先して使用する。無ければ番号でフォールバック
        const label = poly.parcelName || poly.parcelNumber || `画地${createdPolygons + 1}`
        const { error } = await supabase
          .from('design_work_areas')
          .insert({
            farm_id: currentFarm.id,
            work_type: 'boundary_survey',
            zone_number: label,
            name: label,
            point_ids: pointIds,
            area_sqm: null,
            area_ha: null,
            perimeter_m: null,
            notes: null,
          } as never)
        if (!error) createdPolygons++
        else skippedPolygons++
      }

      await fetchWorkAreas(currentFarm.id)

      const parts: string[] = []
      parts.push(`座標 ${newCoords.length} 点を追加（既存 ${result.coordinates.length - newCoords.length} 点はスキップ）`)
      parts.push(`画地 ${createdPolygons} 件を作成`)
      if (skippedPolygons > 0) parts.push(`${skippedPolygons} 件はスキップ`)
      setMessage(parts.join(' / '))
    } catch (err) {
      console.error(err)
      setMessage(err instanceof Error ? err.message : 'インポートに失敗しました')
    } finally {
      setBusy(null)
    }
  }

  const handleExport = () => {
    if (!currentFarm) return
    setBusy('export')
    try {
      const boundaryCoords = coordinates.filter((c) => c.type === 'boundary')
      if (boundaryCoords.length === 0) {
        setMessage('境界座標がありません')
        setBusy(null)
        return
      }
      const polygons: SimaExportPolygon[] = []
      const areas = workAreas['boundary_survey'] ?? []
      // point_ids → 点名（pointNumber）
      const nameById = new Map<string, string>()
      for (const c of coordinates) nameById.set(c.id, c.pointNumber)
      areas.forEach((a, idx) => {
        const pns = a.pointIds
          .map((id) => nameById.get(id))
          .filter((p): p is string => !!p)
        if (pns.length < 3) return
        // 出力時の番号は連番、名称は地番名（zone_number/name は同じ地番名が入っている）
        polygons.push({
          parcelNumber: String(idx + 1),
          parcelName: a.name || a.zoneNumber || `画地${idx + 1}`,
          pointNumbers: pns,
        })
      })
      const projectName = currentFarm.name || 'NoName'
      downloadSimaFile(
        {
          projectName,
          zone,
          points: boundaryCoords.map((c) => ({
            pointNumber: c.pointNumber,
            x: c.x,
            y: c.y,
            z: c.z,
          })),
          polygons,
        },
        `${projectName}_境界測量.sim`,
      )
      setMessage(`座標 ${boundaryCoords.length} 点 / 画地 ${polygons.length} 件を出力しました`)
    } catch (err) {
      console.error(err)
      setMessage(err instanceof Error ? err.message : 'エクスポートに失敗しました')
    } finally {
      setBusy(null)
    }
  }

  // 副作用なし: 型エラー回避（未使用 import を抑止）
  void ({} as DesignWorkArea)

  return (
    <>
      <GenericWorkAreaPage
        workType="boundary_survey"
        areaLabel="地番データ"
        headerActions={
          <div className="flex items-center gap-2">
            {message && (
              <span className="text-xs text-slate-600 max-w-[20rem] truncate" title={message}>
                {message}
              </span>
            )}
            <button
              onClick={handleOpenImport}
              disabled={busy !== null || !currentFarm}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === 'import' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              SIMA 取込
            </button>
            <button
              onClick={handleExport}
              disabled={busy !== null || !currentFarm}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
            >
              {busy === 'export' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              SIMA 出力
            </button>
          </div>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".sim,.SIM,application/octet-stream,text/plain"
        onChange={handleFileChosen}
        className="hidden"
      />
    </>
  )
}
