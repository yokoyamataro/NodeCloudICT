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
import { loadJpgisXmlFile } from '@/lib/jpgis-parser'
import { supabase } from '@/lib/supabase'
import type { CoordinateRow } from '@/stores/coordinateStore'
import type { DesignWorkArea } from '@/types/database'

export function BoundarySurveyWorkAreaPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const xmlFileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'import' | 'export' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // インポート進捗
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)

  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const {
    coordinates,
    importCoordinates,
    fetchCoordinates,
    invalidateCache: invalidateCoordCache,
  } = useCoordinateStore()
  const {
    workAreas,
    fetchWorkAreas,
    invalidateCache: invalidateWorkAreaCache,
  } = useWorkAreaStore()

  const project = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)
    : null
  const zone = project?.coordinate_zone ?? 13

  // 工区あたりの上限。SIMA 取り込みで上限を超える場合は弾く。
  const MAX_COORDS_PER_FARM = 5000
  const MAX_PARCELS_PER_FARM = 1000
  const currentParcelCount = workAreas['boundary_survey']?.length ?? 0
  const currentCoordCount = coordinates.length

  const handleOpenImport = () => fileRef.current?.click()
  const handleOpenJpgisImport = () => xmlFileRef.current?.click()

  // JPGIS (SIMA XML) 取り込み。SIMA テキストフローを踏襲しつつ、画地に owner / area が
  // 入っているのを parcels に反映する。
  const handleJpgisFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !currentFarm) return
    setBusy('import')
    setMessage(null)
    setProgress({ phase: 'ファイル解析中', done: 0, total: 0 })
    try {
      const result = await loadJpgisXmlFile(file)

      // 座標系が工事と違うときは警告だけ出して継続
      if (result.system != null && result.system !== zone) {
        const ok = confirm(
          `XML の座標系（第${result.system}系）が工事の座標系（第${zone}系）と異なります。\n座標値はそのまま取り込みます。続行しますか？`,
        )
        if (!ok) {
          setBusy(null)
          setProgress(null)
          return
        }
      }

      // 1) 座標の差分を作る（既存と同じ pointNumber はスキップ）
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

      // 上限チェック
      const totalCoordsAfter = currentCoordCount + newCoords.length
      const totalParcelsAfter = currentParcelCount + result.polygons.length
      if (totalCoordsAfter > MAX_COORDS_PER_FARM) {
        setProgress(null)
        setBusy(null)
        alert(
          `この XML を取り込むと座標が ${totalCoordsAfter.toLocaleString()} 点になり、` +
            `工区あたりの上限 (${MAX_COORDS_PER_FARM.toLocaleString()} 点) を超えます。\n\n` +
            `現在: ${currentCoordCount.toLocaleString()} 点 / 取り込み追加: ${newCoords.length.toLocaleString()} 点\n` +
            `工区を分けるか、XML を分割してから再度お試しください。`,
        )
        return
      }
      if (totalParcelsAfter > MAX_PARCELS_PER_FARM) {
        setProgress(null)
        setBusy(null)
        alert(
          `この XML を取り込むと地番が ${totalParcelsAfter.toLocaleString()} 筆になり、` +
            `工区あたりの上限 (${MAX_PARCELS_PER_FARM.toLocaleString()} 筆) を超えます。\n\n` +
            `現在: ${currentParcelCount.toLocaleString()} 筆 / 取り込み追加: ${result.polygons.length.toLocaleString()} 筆\n` +
            `工区を分けるか、XML を分割してから再度お試しください。`,
        )
        return
      }

      let insertedCoords: CoordinateRow[] = []
      if (newCoords.length > 0) {
        setProgress({ phase: '座標を取り込み中', done: 0, total: newCoords.length })
        insertedCoords = await importCoordinates(
          newCoords,
          (done, total) => {
            setProgress({ phase: '座標を取り込み中', done, total })
          },
          { skipStateUpdate: true },
        )
      }

      // 点番号 → 座標 ID マップ
      const idByName = new Map<string, string>()
      for (const c of coordinates) idByName.set(c.pointNumber, c.id)
      for (const c of insertedCoords) idByName.set(c.pointNumber, c.id)

      // 2) 画地 → design_work_areas（同時に owner/area を parcels 用に控えておく）
      let createdPolygons = 0
      let skippedPolygons = 0
      const insertRows: Array<{
        farm_id: string
        work_type: string
        zone_number: string
        name: string
        point_ids: string[]
        area_sqm: null
        area_ha: null
        perimeter_m: null
        notes: null
      }> = []
      const meta: Array<{
        label: string
        ownerName: string | null
        registeredAreaSqm: number | null
      }> = []
      for (const poly of result.polygons) {
        const pointIds = poly.pointNumbers
          .map((pn) => idByName.get(pn))
          .filter((id): id is string => !!id)
        if (pointIds.length < 3) {
          skippedPolygons++
          continue
        }
        const label = poly.parcelName || poly.parcelNumber || `画地${insertRows.length + 1}`
        insertRows.push({
          farm_id: currentFarm.id,
          work_type: 'boundary_survey',
          zone_number: label,
          name: label,
          point_ids: pointIds,
          area_sqm: null,
          area_ha: null,
          perimeter_m: null,
          notes: null,
        })
        meta.push({
          label,
          ownerName: poly.ownerName,
          registeredAreaSqm: poly.registeredAreaSqm,
        })
      }

      // 100 件ずつ INSERT。.select('id') で返却 ID を取り、parcels upsert に使う。
      const POLY_CHUNK = 100
      setProgress({ phase: '画地を取り込み中', done: 0, total: insertRows.length })
      const parcelUpserts: Array<{
        work_area_id: string
        parcel_number: string
        registered_owner_name: string | null
        registered_area_sqm: number | null
      }> = []
      for (let i = 0; i < insertRows.length; i += POLY_CHUNK) {
        const slice = insertRows.slice(i, i + POLY_CHUNK)
        const sliceMeta = meta.slice(i, i + POLY_CHUNK)
        const { data, error } = await supabase
          .from('design_work_areas')
          .insert(slice as never)
          .select('id')
        if (error) {
          console.error('画地 INSERT 失敗:', error)
          skippedPolygons += slice.length
        } else {
          createdPolygons += slice.length
          const rows = (data as { id: string }[] | null) ?? []
          for (let j = 0; j < rows.length; j++) {
            const m = sliceMeta[j]
            if (!m) continue
            parcelUpserts.push({
              work_area_id: rows[j].id,
              parcel_number: m.label,
              registered_owner_name: m.ownerName,
              registered_area_sqm: m.registeredAreaSqm,
            })
          }
        }
        setProgress({
          phase: '画地を取り込み中',
          done: Math.min(i + POLY_CHUNK, insertRows.length),
          total: insertRows.length,
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      // 3) parcels に owner / area / parcel_number を upsert（DB トリガで行は既に作られている前提）
      if (parcelUpserts.length > 0) {
        setProgress({
          phase: '地番属性を反映中',
          done: 0,
          total: parcelUpserts.length,
        })
        const PARCEL_CHUNK = 200
        for (let i = 0; i < parcelUpserts.length; i += PARCEL_CHUNK) {
          const slice = parcelUpserts.slice(i, i + PARCEL_CHUNK)
          const { error } = await supabase
            .from('parcels')
            .upsert(slice as never, { onConflict: 'work_area_id' })
          if (error) {
            console.error('parcels upsert 失敗:', error)
          }
          setProgress({
            phase: '地番属性を反映中',
            done: Math.min(i + PARCEL_CHUNK, parcelUpserts.length),
            total: parcelUpserts.length,
          })
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      setProgress({ phase: '工事区域を再読込中', done: 0, total: 0 })
      invalidateCoordCache()
      invalidateWorkAreaCache()
      await fetchWorkAreas(currentFarm.id)
      await fetchCoordinates(currentFarm.id)

      const parts: string[] = []
      parts.push(
        `座標 ${newCoords.length} 点を追加（既存 ${(result.coordinates.length - newCoords.length).toLocaleString()} 点はスキップ）`,
      )
      parts.push(`地番 ${createdPolygons} 件を作成`)
      if (skippedPolygons > 0) parts.push(`${skippedPolygons} 件はスキップ`)
      setMessage(parts.join(' / '))
    } catch (err) {
      console.error(err)
      setMessage(err instanceof Error ? err.message : 'インポートに失敗しました')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !currentFarm) return
    setBusy('import')
    setMessage(null)
    setProgress({ phase: 'ファイル解析中', done: 0, total: 0 })
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

      // 工区あたりの上限チェック
      const totalCoordsAfter = currentCoordCount + newCoords.length
      const totalParcelsAfter = currentParcelCount + result.polygons.length
      if (totalCoordsAfter > MAX_COORDS_PER_FARM) {
        setProgress(null)
        setBusy(null)
        alert(
          `この SIMA を取り込むと座標が ${totalCoordsAfter.toLocaleString()} 点になり、` +
            `工区あたりの上限 (${MAX_COORDS_PER_FARM.toLocaleString()} 点) を超えます。\n\n` +
            `現在: ${currentCoordCount.toLocaleString()} 点 / 取り込み追加: ${newCoords.length.toLocaleString()} 点\n` +
            `工区を分けるか、SIMA を分割してから再度お試しください。`,
        )
        return
      }
      if (totalParcelsAfter > MAX_PARCELS_PER_FARM) {
        setProgress(null)
        setBusy(null)
        alert(
          `この SIMA を取り込むと地番が ${totalParcelsAfter.toLocaleString()} 筆になり、` +
            `工区あたりの上限 (${MAX_PARCELS_PER_FARM.toLocaleString()} 筆) を超えます。\n\n` +
            `現在: ${currentParcelCount.toLocaleString()} 筆 / 取り込み追加: ${result.polygons.length.toLocaleString()} 筆\n` +
            `工区を分けるか、SIMA を分割してから再度お試しください。`,
        )
        return
      }

      let insertedCoords: CoordinateRow[] = []
      if (newCoords.length > 0) {
        setProgress({ phase: '座標を取り込み中', done: 0, total: newCoords.length })
        // skipStateUpdate=true: インポート中はストアに 11k+ の座標を入れない
        // （CoordinateMap が全 marker をレンダーして JS スレッドが詰まるのを防ぐ）。
        // 取り込み完了後に fetchCoordinates で 1 度だけ反映する
        insertedCoords = await importCoordinates(
          newCoords,
          (done, total) => {
            setProgress({ phase: '座標を取り込み中', done, total })
          },
          { skipStateUpdate: true },
        )
      }

      // 2) 既存 coordinates + insertedCoords で 点番号 → ID マップを構築（再 fetch 不要）
      const idByName = new Map<string, string>()
      for (const c of coordinates) idByName.set(c.pointNumber, c.id)
      for (const c of insertedCoords) idByName.set(c.pointNumber, c.id)

      // 3) 画地を design_work_areas に挿入（work_type='boundary_survey'）
      // 大量地番対応: 100 件ずつチャンクして INSERT する。1 件ずつ逐次だと
      // 数千件で実質ハング状態になるため。チャンクが大きすぎると最後の
      // バッチで応答が返ってこないケースが出るので、座標と同じく小さめに。
      let createdPolygons = 0
      let skippedPolygons = 0
      const polyTotal = result.polygons.length
      const POLY_CHUNK = 100

      // 構成点 3 点未満の画地はスキップ。残りを INSERT 行に整形
      const insertRows: Array<{
        farm_id: string
        work_type: string
        zone_number: string
        name: string
        point_ids: string[]
        area_sqm: null
        area_ha: null
        perimeter_m: null
        notes: null
      }> = []
      for (let i = 0; i < polyTotal; i++) {
        const poly = result.polygons[i]
        const pointIds = poly.pointNumbers
          .map((pn) => idByName.get(pn))
          .filter((id): id is string => !!id)
        if (pointIds.length < 3) {
          skippedPolygons++
          continue
        }
        const label = poly.parcelName || poly.parcelNumber || `画地${insertRows.length + 1}`
        insertRows.push({
          farm_id: currentFarm.id,
          work_type: 'boundary_survey',
          zone_number: label,
          name: label,
          point_ids: pointIds,
          area_sqm: null,
          area_ha: null,
          perimeter_m: null,
          notes: null,
        })
      }

      setProgress({ phase: '画地を取り込み中', done: 0, total: insertRows.length })
      for (let i = 0; i < insertRows.length; i += POLY_CHUNK) {
        const slice = insertRows.slice(i, i + POLY_CHUNK)
        const { error } = await supabase
          .from('design_work_areas')
          .insert(slice as never)
        if (error) {
          // チャンクごと失敗した分はスキップ扱いにして続行する（一部失敗で全停止しない）
          console.error('画地 INSERT 失敗:', error)
          skippedPolygons += slice.length
        } else {
          createdPolygons += slice.length
        }
        setProgress({
          phase: '画地を取り込み中',
          done: Math.min(i + POLY_CHUNK, insertRows.length),
          total: insertRows.length,
        })
        // UI を描画する時間を明示的に確保
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      setProgress({ phase: '工事区域を再読込中', done: 0, total: 0 })
      // SIMA 取り込みでサーバ側に大量行が追加されたので、両ストアの
      // キャッシュを無効化して最新を取り直す
      invalidateCoordCache()
      invalidateWorkAreaCache()
      await fetchWorkAreas(currentFarm.id)
      await fetchCoordinates(currentFarm.id)

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
      setProgress(null)
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
        areaLabel="地番管理"
        headerActions={
          <div className="flex items-center gap-2">
            {/* 工区あたりの使用量 (上限の何 % か) */}
            {!progress && (
              <div className="flex items-center gap-3 text-[11px] text-slate-600 px-2 py-1 border rounded bg-slate-50">
                <span>
                  座標{' '}
                  <span
                    className={
                      currentCoordCount >= MAX_COORDS_PER_FARM
                        ? 'font-mono font-semibold text-red-600'
                        : currentCoordCount >= MAX_COORDS_PER_FARM * 0.9
                          ? 'font-mono font-semibold text-amber-600'
                          : 'font-mono'
                    }
                  >
                    {currentCoordCount.toLocaleString()}
                  </span>
                  <span className="text-slate-400"> / {MAX_COORDS_PER_FARM.toLocaleString()}</span>
                </span>
                <span>
                  地番{' '}
                  <span
                    className={
                      currentParcelCount >= MAX_PARCELS_PER_FARM
                        ? 'font-mono font-semibold text-red-600'
                        : currentParcelCount >= MAX_PARCELS_PER_FARM * 0.9
                          ? 'font-mono font-semibold text-amber-600'
                          : 'font-mono'
                    }
                  >
                    {currentParcelCount.toLocaleString()}
                  </span>
                  <span className="text-slate-400"> / {MAX_PARCELS_PER_FARM.toLocaleString()}</span>
                </span>
              </div>
            )}
            {progress && (
              <div className="flex items-center gap-2 text-xs text-slate-700">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                <span>
                  {progress.phase}
                  {progress.total > 0 && (
                    <>
                      <span className="font-mono ml-1">
                        {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
                      </span>
                      <span className="ml-1 text-slate-500">
                        ({progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%)
                      </span>
                    </>
                  )}
                </span>
                {progress.total > 0 && (
                  <div className="w-32 h-2 bg-slate-200 rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-600 transition-[width] duration-150"
                      style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {!progress && message && (
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
              地番SIM取り込み
            </button>
            <button
              onClick={handleOpenJpgisImport}
              disabled={busy !== null || !currentFarm}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === 'import' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              地番SIM(JPGIS.XML)取り込み
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
      <input
        ref={xmlFileRef}
        type="file"
        accept=".xml,.XML,application/xml,text/xml"
        onChange={handleJpgisFileChosen}
        className="hidden"
      />
    </>
  )
}
