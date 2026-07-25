// 境界測量: 地番データ（座標 + 画地ポリゴン）の SIMA 入出力対応
//
// SIMA インポート: 座標 → design_coordinates (type='boundary'), 画地 → design_work_areas
// SIMA エクスポート: 現工区の boundary 座標 + boundary_survey 工事区域を出力

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Upload,
  Loader2,
  FileSpreadsheet,
  X,
  Check,
  ChevronDown,
  Palette,
} from 'lucide-react'
import { GenericWorkAreaPage } from '@/components/work-area/GenericWorkAreaPage'
import { CadastralCsvExportModal } from './CadastralCsvExportModal'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useParcelAttributeTypesStore } from '@/stores/parcelAttributeTypesStore'
import { ParcelAttributeTypesModal } from './ParcelAttributeTypesModal'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import {
  loadSimaFile,
  downloadSimaFile,
  type SimaExportPolygon,
} from '@/lib/sima-parser'
import { loadJpgisXmlFile } from '@/lib/jpgis-parser'
import { supabase } from '@/lib/supabase'
import type { CoordinateRow } from '@/stores/coordinateStore'
import type { DesignWorkArea } from '@/types/database'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { type Bbox } from '@/lib/tile-math'
import { useParcelImportSelection } from '@/features/parcel-maps/useParcelImportSelection'
import { ParcelBatchImportBar } from '@/features/parcel-maps/ParcelBatchImportBar'
import { useMapViewStore } from '@/stores/mapViewStore'

export function BoundarySurveyWorkAreaPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const xmlFileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'import' | 'export' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [csvOpen, setCsvOpen] = useState(false)
  // インポート進捗
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null)
  // 「地番入力」「地番出力」ドロップダウンの開閉 (座標入力/出力と同じパターン)
  const [openMenu, setOpenMenu] = useState<'import' | 'export' | null>(null)
  // 地番SIM 出力: 「対象地選択」モード中の選択済 area ID 集合。null なら選択モード OFF
  const [simSelectedIds, setSimSelectedIds] = useState<Set<string> | null>(null)
  // 属性管理モーダル
  const [showAttributeMgmt, setShowAttributeMgmt] = useState(false)

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

  // ---- 地番マップ (法務省地図) の背景レイヤ ----
  // トグル・データセット取得は GenericWorkAreaPage 側に集約。ここでは
  // 表示状態を store から購読するだけ (選択モード連動のため)。
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const hasActiveDataset = parcelDatasets.some((d) => d.active)
  const showParcelLayer = useMapViewStore((s) => s.showParcelMap)

  // 地番マップの表示範囲は常に「現在の地図ビュー」に追従する。
  // 以前は「工区+Nm」プリセットで固定していたが、features 数が数千〜数万
  // になってラベル bind が固まる原因になるため撤去。
  // (farm.parcel_map_bbox に管理者が手動固定した bbox があれば尊重する)
  const effectiveParcelBbox: Bbox | null =
    (currentFarm?.parcel_map_bbox as Bbox | null | undefined) ?? null

  // 取込済セット (背景レイヤで色分けに使う)。
  // キーは "所在|地番" の複合値。所在の異なる同一地番 (例: 朝日町 10-10 と
  // 桜町 10-10) を別物として扱う。
  const parcelsByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const importedParcelKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of parcelsByWorkAreaId.values()) {
      if (!p.parcel_number) continue
      s.add(`${p.location ?? ''}|${p.parcel_number}`)
    }
    // parcels 未 upsert のケース: 工区一覧の name / zone_number も入れておく
    // (所在情報は付与できないので "|地番" 形式でフォールバック)
    const areas = workAreas['boundary_survey'] ?? []
    for (const a of areas) {
      if (a.name) s.add(`|${a.name}`)
      if (a.zoneNumber && a.zoneNumber !== a.name) s.add(`|${a.zoneNumber}`)
    }
    return s
  }, [parcelsByWorkAreaId, workAreas])

  // ---- 複数地番の選択状態 (共通フックへ委譲) ----
  // 地図上のポリゴンクリック時のポップアップから追加/解除できる。
  // 法務省地図が OFF になったら resetTrigger で自動的に選択解除される。
  const parcelSelection = useParcelImportSelection({ resetTrigger: showParcelLayer })
  const {
    selectionMode,
    selectedKeys,
    toggleSelect: toggleSelectedParcel,
    message: parcelImportMessage,
  } = parcelSelection
  // parcelSelection.message は SIMA 取込等の共通 message state と混ぜる
  useEffect(() => {
    if (parcelImportMessage) setMessage(parcelImportMessage)
  }, [parcelImportMessage])

  // 地番属性 (parcel_attribute_types) をプロジェクト単位で fetch
  const fetchAttributeTypes = useParcelAttributeTypesStore((s) => s.fetchForProject)
  useEffect(() => {
    const pid = currentFarm?.project_id
    if (pid) void fetchAttributeTypes(pid)
  }, [currentFarm?.project_id, fetchAttributeTypes])


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

  const handleExport = (filterAreaIds?: Set<string>) => {
    if (!currentFarm) return
    setBusy('export')
    try {
      const allAreas = workAreas['boundary_survey'] ?? []
      const areas = filterAreaIds
        ? allAreas.filter((a) => filterAreaIds.has(a.id))
        : allAreas
      if (filterAreaIds && areas.length === 0) {
        setMessage('選択された地番がありません')
        setBusy(null)
        return
      }
      // 出力対象 = 「地番構成点」= polygon (画地) が参照している全座標。
      // 点種 (boundary / confirmed_boundary / measured / cadastral_diagram
      // 等) でフィルタしない — 型が boundary で無いだけで地番構成点となる
      // べき座標が抜け落ちてしまうため。
      // ポリゴンに含まれていない点 (control / current / staking 等) は
      // 地番構成点ではないので出力しない。
      const coordById = new Map<string, CoordinateRow>()
      for (const c of coordinates) coordById.set(c.id, c)
      const exportCoords: CoordinateRow[] = []
      const seen = new Set<string>()
      for (const a of areas) {
        for (const id of a.pointIds) {
          if (seen.has(id)) continue
          const c = coordById.get(id)
          if (!c) continue
          seen.add(id)
          exportCoords.push(c)
        }
      }
      if (exportCoords.length === 0) {
        setMessage('出力対象の地番構成点がありません (画地が未定義)')
        setBusy(null)
        return
      }

      // coord.id → exportCoords 内の 0-based index。B01 は index ベースで
      // 参照するので、同名点があっても正しく地番形状に紐付けできる。
      const seqIdxById = new Map<string, number>()
      exportCoords.forEach((c, i) => seqIdxById.set(c.id, i))

      const polygons: SimaExportPolygon[] = []
      const missingRefs: string[] = []
      areas.forEach((a, idx) => {
        const indices: number[] = []
        for (const id of a.pointIds) {
          const i = seqIdxById.get(id)
          if (i === undefined) {
            missingRefs.push(`${a.name ?? a.id}: ${id}`)
            continue
          }
          indices.push(i)
        }
        if (indices.length < 3) return
        polygons.push({
          parcelNumber: String(idx + 1),
          parcelName: a.name || a.zoneNumber || `画地${idx + 1}`,
          pointIndices: indices,
        })
      })
      if (missingRefs.length > 0) {
        console.warn('[SIMA export] polygon references failed:', missingRefs)
      }

      const projectName = currentFarm.name || 'NoName'
      downloadSimaFile(
        {
          projectName,
          zone,
          // 点名 は NodeCloud に保存されている元の pointNumber をそのまま出力。
          // 点番 (A01 index) は writer 側で 1 から順に自動割り当てされる。
          points: exportCoords.map((c) => ({
            pointNumber: c.pointNumber,
            x: c.x,
            y: c.y,
            z: c.z,
          })),
          polygons,
        },
        `${projectName}_境界測量.sim`,
      )
      const msg = `座標 ${exportCoords.length} 点 / 画地 ${polygons.length} 件を出力しました`
      const warn =
        missingRefs.length > 0
          ? ` (画地から未解決参照 ${missingRefs.length} 件をスキップ)`
          : ''
      setMessage(msg + warn)
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
            {/* 地番入力 / 地番出力 ボタンは「区域登録」ヘッダに移動
                (座標入力 / 座標出力 と同じ配置ポリシー) */}
          </div>
        }
        areaListActions={
          <>
            {/* 属性管理 (地番属性の色/ラベル/追加削除) */}
            <button
              type="button"
              onClick={() => setShowAttributeMgmt(true)}
              disabled={!currentFarm}
              title="地番属性の管理 (対象地/隣接地/道路/河川/その他 の色・ラベル + 任意属性追加)"
              className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
            >
              <Palette className="h-3.5 w-3.5" />
              属性管理
            </button>

            {/* 地番入力: SIM取り込み / JPGIS.XML取り込み */}
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenMenu(openMenu === 'import' ? null : 'import')
                }
                disabled={busy !== null || !currentFarm}
                title="地番入力 (SIM / JPGIS.XML)"
                className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === 'import' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                地番入力
                <ChevronDown className="h-3 w-3" />
              </button>
              {openMenu === 'import' && (
                <div
                  className="absolute right-0 top-full mt-1 w-52 bg-white border rounded shadow-lg z-[1200] text-sm"
                  onMouseLeave={() => setOpenMenu(null)}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      handleOpenImport()
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b"
                  >
                    SIM取り込み (.sim)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      handleOpenJpgisImport()
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50"
                  >
                    JPGIS.XML取り込み (.xml)
                  </button>
                </div>
              )}
            </div>

            {/* 地番出力: 地番SIM (全 / 対象地選択) / CSV */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  if (simSelectedIds) return
                  setOpenMenu(openMenu === 'export' ? null : 'export')
                }}
                disabled={busy !== null || !currentFarm || !!simSelectedIds}
                title={
                  simSelectedIds
                    ? '対象地選択モード中 — 地図上で地番をクリックして選択'
                    : '地番出力 (地番SIM / CSV)'
                }
                className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === 'export' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                地番出力
                <ChevronDown className="h-3 w-3" />
              </button>
              {openMenu === 'export' && (
                <div
                  className="absolute right-0 top-full mt-1 w-56 bg-white border rounded shadow-lg z-[1200] text-sm"
                  onMouseLeave={() => setOpenMenu(null)}
                >
                  <div className="px-3 pt-2 pb-1 text-[10px] text-slate-400 uppercase tracking-wide">
                    地番SIM
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      handleExport()
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2"
                  >
                    <span>全地番を出力</span>
                    <span className="text-xs text-slate-500">
                      {(workAreas['boundary_survey'] ?? []).length} 筆
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      setSimSelectedIds(new Set())
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b"
                  >
                    対象地を選択して出力
                  </button>
                  <div className="px-3 pt-2 pb-1 text-[10px] text-slate-400 uppercase tracking-wide">
                    CSV
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      setCsvOpen(true)
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 text-slate-500" />
                    CSV出力
                  </button>
                </div>
              )}
            </div>
          </>
        }
        mapChildren={
          hasActiveDataset ? (
            <ParcelMapLayer
              visible={showParcelLayer}
              bbox={effectiveParcelBbox}
              importedParcelKeys={importedParcelKeys}
              selectedKeys={selectedKeys}
              onToggleSelect={toggleSelectedParcel}
              selectionMode={selectionMode}
            />
          ) : null
        }
        suppressDefaultParcelMapLayer
        checkedPolygonIds={simSelectedIds ?? undefined}
        onPolygonToggleCheck={
          simSelectedIds
            ? (id: string) => {
                setSimSelectedIds((prev) => {
                  if (!prev) return prev
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
            : undefined
        }
        mapBottomLeftOverlay={
          hasActiveDataset && showParcelLayer ? (
            /* 地番データ取込ボタン (共通)。法務省地図トグル自体は GenericWorkAreaPage が
               bottom-left に描く。 */
            <ParcelBatchImportBar
              farmId={currentFarm?.id ?? null}
              zone={zone}
              selection={parcelSelection}
            />
          ) : null
        }
      />
      {csvOpen && <CadastralCsvExportModal onClose={() => setCsvOpen(false)} />}
      {showAttributeMgmt && currentFarm?.project_id && (
        <ParcelAttributeTypesModal
          projectId={currentFarm.project_id}
          onClose={() => setShowAttributeMgmt(false)}
        />
      )}

      {/* 地番SIM 出力: 対象地選択モードのフローティングバナー */}
      {simSelectedIds && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-[1300] flex items-center gap-3 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white shadow-xl"
          role="dialog"
        >
          <span>
            対象地選択中: {simSelectedIds.size} 筆 /{' '}
            {(workAreas['boundary_survey'] ?? []).length} 筆
          </span>
          <div className="flex items-center gap-2 border-l border-white/40 pl-3">
            <button
              type="button"
              onClick={() => {
                const all = new Set(
                  (workAreas['boundary_survey'] ?? []).map((a) => a.id),
                )
                setSimSelectedIds(all)
              }}
              className="rounded bg-white/20 px-2 py-1 text-xs hover:bg-white/30"
            >
              全選択
            </button>
            <button
              type="button"
              onClick={() => setSimSelectedIds(new Set())}
              className="rounded bg-white/20 px-2 py-1 text-xs hover:bg-white/30"
              disabled={simSelectedIds.size === 0}
            >
              全解除
            </button>
            <button
              type="button"
              onClick={() => setSimSelectedIds(null)}
              className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs hover:bg-white/30"
            >
              <X className="h-3 w-3" />
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => {
                const sel = simSelectedIds
                setSimSelectedIds(null)
                if (sel && sel.size > 0) handleExport(sel)
              }}
              disabled={simSelectedIds.size === 0}
              className="flex items-center gap-1 rounded bg-white px-3 py-1 text-xs font-bold text-orange-600 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check className="h-3 w-3" />
              確定 ({simSelectedIds.size}筆)
            </button>
          </div>
        </div>
      )}
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
